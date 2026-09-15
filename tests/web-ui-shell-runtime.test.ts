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

test("composer skill picker stays scoped to Claude SDK structured sessions", () => {
  const engine = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const events = readFileSync(path.join(root, "src/web-ui/browser/events.ts"), "utf8");

  assert.match(engine, /session\.sessionKind === "structured"/);
  assert.match(engine, /session\.provider === "claude"/);
  assert.match(engine, /session\.runner === "claude-sdk"/);
  assert.match(engine, /data-claude-skills-trigger/);
  assert.match(input, /supportsClaudeSkillSelection\(session\) \? \{ skills: getSelectedClaudeSkills\(session\) \} : \{\}/);
  assert.match(events, /data-claude-skill-name/);
});

test("PTY running indicators stop when the provider exits into its retained shell", () => {
  const utils = readFileSync(path.join(root, "src/web-ui/browser/utils.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  assert.match(utils, /session\.providerCliActive !== false/);
  // provider CLI 会话必须 ptyBusy 信号才显示运行中；裸 shell 保持进程存活即运行
  assert.match(utils, /var ptyRunning = ptyTurnActive\(session\) && providerCliRunning;/);
  assert.match(utils, /if \(isProviderCliSession\(session\)\) return session\.ptyBusy === true;/);
  assert.match(sessions, /capabilities: \{ ptyAck: true \}/);
});

test("terminal initialization cannot expose PTY chrome for a structured session", () => {
  const terminal = readFileSync(path.join(root, "src/web-ui/browser/terminal.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");

  assert.match(terminal, /var shouldExposeTerminal = !!selectedSession\s*&& !isStructuredSession\(selectedSession\)\s*&& state\.currentView === "terminal";/s);
  assert.match(terminal, /if \(shouldExposeTerminal\) \{\s*container\.classList\.remove\("hidden"\);\s*container\.classList\.add\("active"\);/s);
  assert.doesNotMatch(terminal, /if \(state\.selectedId\) \{\s*container\.classList\.remove\("hidden"\)/s);
  assert.match(sessions, /!state\.terminal && terminalContainer && selectedSession && !isStructuredSession\(selectedSession\)/);
});

test("terminal snapshots survive WebSocket init arriving before xterm mounts", () => {
  const state = readFileSync(path.join(root, "src/web-ui/browser/state.ts"), "utf8");
  const terminal = readFileSync(path.join(root, "src/web-ui/browser/terminal.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");

  assert.match(state, /terminalStatesBySession: \{\}/);
  assert.match(terminal, /if \(sessionId\) state\.terminalStatesBySession\[sessionId\] = snapshot;/);
  assert.match(terminal, /if \(!state\.terminal\) return true;/);
  assert.match(terminal, /session\.terminalState \|\| cachedState/);
  assert.match(sessions, /if \(!sessionIds\.has\(id\)\) delete state\.terminalStatesBySession\[id\]/);
});

test("PTY terminal interaction keeps a usable web composer and only the native embed hides it", () => {
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  const styles = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");

  assert.match(input, /composerShell\.classList\.toggle\("is-terminal-interactive", !!state\.terminalInteractive\)/);
  assert.match(input, /shouldUseTerminalPassthrough\(selectedSession\)/);
  assert.match(input, /var terminalPassthrough = el\.classList\.contains\("is-terminal-passthrough"\)/);
  assert.match(render, /state\.terminalInteractive \? ' is-terminal-interactive' : ''/);
  // 网页端 composer 是真实的 PTY 输入面：保留 textarea，只收纳 Agent-only 章节。
  assert.match(styles, /\.input-composer\.is-terminal-interactive \.composer-input-wrap[\s\S]*?display: flex;/);
  assert.match(styles, /\.input-composer\.is-terminal-interactive \.composer-actions-left[\s\S]*?display: none !important;/);
  // 直通规则必须带 html:not(.is-wand-app) 前缀：基础 composer 规则在
  // :focus-within / .is-expanded 变体下是 0-3-1 特指度，不带前缀的直通规则只有
  // 0-3-0，打字（textarea 聚焦）时会输给基础规则，把 composer 顶回 84/100px。
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-main-row[\s\S]*?grid-template-rows: auto;/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive:focus-within \.composer-main-row/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.input-textarea[\s\S]*?height: 40px;/);
  // 原生嵌入壳才把 drafting row 整个交还给原生底栏。
  assert.match(styles, /html\.is-wand-embed-terminal \.input-composer\.is-terminal-interactive \.composer-input-wrap[\s\S]*?display: none;/);
  assert.match(styles, /html\.is-wand-embed-terminal \.input-composer\.is-terminal-interactive \.composer-main-row[\s\S]*?grid-template-rows: 48px;[\s\S]*?min-height: 48px;/);
  // #input-box 自己拥有按键（逐字透传走 input 事件），不能再被 keydown 捕获重复发送。
  assert.match(input, /if \(target\.closest && target\.closest\("#input-box"\)\) return false;/);
  // Enter 提交：先文本（若有）后单独 "\r"，符合 PTY 输入契约。
  assert.match(input, /queueDirectInput\("\\r", "enter_text"\)/);
  // 直通模式下退格翻译成 \x7f 送给 PTY，而不是在空 textarea 里做本地删除。
  assert.match(sessions, /state\.terminalInteractive\s*&& !document\.documentElement\.classList\.contains\("is-wand-embed-terminal"\)[\s\S]*?String\.fromCharCode\(127\), "backspace"/);
});

test("PTY passthrough composer renders its trailing action with Appica", () => {
  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const adapter = readFileSync(path.join(root, "src/web-ui/browser/composer-rail-adapter.ts"), "utf8");
  const host = readFileSync(path.join(root, "src/web-ui/react/composer-rail/host.tsx"), "utf8");
  const overlay = readFileSync(path.join(root, "src/web-ui/react/overlay-host.tsx"), "utf8");
  const styles = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");

  // 宿主 span 由 composer 标记提供，端口渲染进 composer-actions-right。
  assert.match(render, /<span class="composer-rail-host" data-composer-rail-host="pty"><\/span>/);
  assert.match(overlay, /<ComposerRailHost \/>/);
  // 业务模块只认 Wand*，第三方组件 API 不进 browser/ 层。
  assert.match(host, /<WandButton[\s\S]*?<WandIcon name="enter" slot="start"/);
  assert.doesNotMatch(host, /@appica\/ui-react/);
  // 只有「网页端 + 直通 + 非嵌入壳」才挂载；原生壳与结构化会话都要清空。
  assert.match(
    input,
    /syncBrowserComposerRail\(\{[\s\S]*?return !!state\.terminalInteractive[\s\S]*?!document\.documentElement\.classList\.contains\("is-wand-embed-terminal"\)/,
  );
  assert.match(adapter, /if \(!config\.active\(\)\) \{[\s\S]*?composerRailController\.clear\(\);/);
  assert.match(adapter, /document\.querySelectorAll<HTMLElement>\("\[data-composer-rail-host\]"\)/);
  // 空宿主不占位（结构化会话保留 legacy 发送按钮），直通下按钮与 40px 输入框对齐。
  assert.match(styles, /\.composer-rail-host:empty \{\s*display: none;/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-rail-host[\s\S]*?min-height: 40px;/);
});

test("composer rail controller publishes and clears Appica mounts", async () => {
  const { composerRailController } = await import("../src/web-ui/react/composer-rail/controller.js");
  const target = {} as HTMLElement;
  let notified = 0;
  const unsubscribe = composerRailController.subscribe(() => { notified += 1; });

  try {
    composerRailController.clear();
    assert.equal(composerRailController.getSnapshot().mounts.length, 0);

    composerRailController.sync([{ key: "pty", target, onSubmit() {} }]);
    const snapshot = composerRailController.getSnapshot();
    assert.equal(snapshot.mounts.length, 1);
    assert.equal(snapshot.mounts[0].key, "pty");
    assert.equal(snapshot.mounts[0].target, target);
    assert.ok(snapshot.revision > 0);

    composerRailController.clear();
    assert.equal(composerRailController.getSnapshot().mounts.length, 0);
    assert.equal(notified, 2);
  } finally {
    unsubscribe();
    composerRailController.clear();
  }
});
