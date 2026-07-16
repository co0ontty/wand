import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isReactShellEnabled,
  REACT_SHELL_STORAGE_KEY,
  REACT_UI_STORAGE_KEY,
} from "../src/web-ui/react/feature-flags.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeWindow(options: {
  href?: string;
  reactUi?: boolean;
  reactShell?: boolean;
  storedReactUi?: string | null;
  storedReactShell?: string | null;
} = {}): Window {
  const featureFlags = options.reactUi === undefined && options.reactShell === undefined
    ? undefined
    : {
        ...(options.reactUi === undefined ? {} : { reactUi: options.reactUi }),
        ...(options.reactShell === undefined ? {} : { reactShell: options.reactShell }),
      };
  return {
    location: { href: options.href ?? "https://wand.test/" },
    __wandFeatureFlags: featureFlags,
    localStorage: {
      getItem(key: string) {
        if (key === REACT_UI_STORAGE_KEY) return options.storedReactUi ?? null;
        assert.equal(key, REACT_SHELL_STORAGE_KEY);
        return options.storedReactShell ?? null;
      },
    },
  } as unknown as Window;
}

test("React UI rollback always selects the legacy authenticated shell", () => {
  assert.equal(isReactShellEnabled(fakeWindow({ href: "https://wand.test/?reactUi=0" })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ href: "https://wand.test/?reactUi=0&reactShell=1" })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ reactUi: false, reactShell: true })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ storedReactUi: "false", storedReactShell: "true" })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ href: "https://wand.test/?reactShell=0" })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ href: "https://wand.test/?reactShell=1" })), true);
  assert.equal(isReactShellEnabled(fakeWindow({ reactShell: false, storedReactShell: "true" })), false);
  assert.equal(isReactShellEnabled(fakeWindow({ storedReactShell: "false" })), false);
});

test("browser shell runtime mounts synchronously once and later publishes only", () => {
  const source = readFileSync(path.join(root, "src/web-ui/browser/shell-runtime.ts"), "utf8");
  assert.match(source, /flushSync\(\(\) => root\.render/);
  assert.match(source, /new LegacyHost<HTMLElement>/);
  assert.match(source, /app\.replaceChildren\(\)/);
  assert.match(source, /runtime\?\.store\.publish\(\{ sync: true, reason: "legacy:render" \}\)/);
  assert.match(source, /if \(runtime\) \{/);
  assert.match(source, /host\.mount\(node\)/);
  assert.doesNotMatch(source, /querySelector\("#app"\)|getElementById\("app"\)/);
});

test("authenticated render bypasses terminal teardown and listener rebinding after mount", () => {
  const source = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  assert.match(source, /!reactShellWasMounted && !!document\.getElementById\("output"\)/);
  assert.match(source, /if \(rebuiltLegacyHosts\) \{\s*resetChatRenderCache\(\);\s*attachEventListeners\(\);/s);
  assert.match(source, /renderBrowserReactShell\(app, renderAppShell\)/);
});

test("React-owned controls are not rebound or imperatively rewritten", () => {
  const events = readFileSync(path.join(root, "src/web-ui/browser/events.ts"), "utf8");
  const sidebar = readFileSync(path.join(root, "src/web-ui/browser/sidebar.ts"), "utf8");
  const files = readFileSync(path.join(root, "src/web-ui/browser/file-browser.ts"), "utf8");
  const folderPicker = readFileSync(path.join(root, "src/web-ui/browser/folder-picker-adapter.ts"), "utf8");
  const websocket = readFileSync(path.join(root, "src/web-ui/browser/websocket.ts"), "utf8");
  const shellRuntime = readFileSync(path.join(root, "src/web-ui/browser/shell-runtime.ts"), "utf8");

  assert.match(events, /var reactShellActive = isBrowserReactShellMounted\(\)/);
  assert.match(events, /if \(!reactShellActive\) \{\s*\/\/ Welcome screen event listeners/s);
  assert.match(sidebar, /if \(isBrowserReactShellMounted\(\)\) return;\s*var target = event\.target/);
  assert.match(files, /if \(cwdEl && !isBrowserReactShellMounted\(\)\)/);
  assert.match(folderPicker, /if \(isBrowserReactShellMounted\(\)\) \{\s*notifyLegacyUiChange\("working-dir"\);\s*return;/s);
  assert.match(folderPicker, /function setTriggerExpanded[\s\S]*if \(isBrowserReactShellMounted\(\)\) return;/);
  assert.match(shellRuntime, /BrowserCrossSessionQueueSlot/);
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  assert.match(input, /getElementById\("cross-session-queue-host"\)/);
  assert.doesNotMatch(input, /parent\s*=\s*isInputPanelVisible\s*\?\s*inputPanel\s*:\s*blankChat/);
  assert.match(websocket, /notifyLegacyUiChange\("task:update"\)/);
  assert.match(websocket, /if \(!reactShellActive && taskEl && task && task\.title\)/);
});
