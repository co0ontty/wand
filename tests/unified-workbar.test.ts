import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WandIcon, WandIconFamily } from "../src/web-ui/react/ui/icons.js";
import { ProviderLogo } from "../src/web-ui/react/provider-logo.js";
import { renderProviderLogoMarkup } from "../src/web-ui/provider-identity.js";
import { getTopbarMoreActions } from "../src/web-ui/react/shell/shell-topbar.js";
import type { UiSessionVm } from "../src/web-ui/react/shell/ui-store.js";
import { FirstStandaloneSessionChrome } from "../src/web-ui/react/workspaces/workspace-tab-chrome.js";

const source = (path: string) => readFileSync(new URL(`../src/web-ui/${path}`, import.meta.url), "utf8");

test("Lucide geometry is scoped to the approved workbar, preserving existing icon metadata", () => {
  const plain = renderToStaticMarkup(React.createElement(WandIcon, { name: "terminal", size: 18 }));
  const scoped = renderToStaticMarkup(React.createElement(WandIconFamily, { value: "lucide" }, React.createElement(WandIcon, { name: "terminal", size: 18, slot: "start" })));
  assert.doesNotMatch(plain, /data-wand-icon-family/);
  assert.match(scoped, /data-wand-icon-family="lucide"/);
  assert.match(scoped, /data-wand-icon="terminal"/);
  assert.match(scoped, /data-icon="start"/);
  assert.match(scoped, /stroke-width="2"/);
});

test("Pi's official colors agree across React and legacy projections", () => {
  const react = renderToStaticMarkup(React.createElement(ProviderLogo, { provider: "pi" }));
  const legacy = renderProviderLogoMarkup("pi");
  for (const fill of ["#F09082", "#4D9ABF", "#F1BE58"]) {
    assert.ok(react.includes(fill)); assert.ok(legacy.includes(fill));
  }
});

test("merged menus identify Pi CLI and Wand Agent native IDs without calling them Claude", () => {
  for (const [engine, label] of [["cli", "Pi"], ["sdk", "Wand Agent"]] as const) {
    const selected = { id: "session", provider: "pi", engine, claudeSessionId: "native-id" } as UiSessionVm;
    const copy = getTopbarMoreActions(selected, null).find(action => action.actionName === "copy-claude-session-id");
    assert.equal(copy?.label, `复制 ${label} 会话 ID`);
  }
});

test("a single real session supplies its title in the tab, with destructive-close scope", () => {
  const html = renderToStaticMarkup(React.createElement(FirstStandaloneSessionChrome, {
    mobile: false, session: { id: "s", title: "唯一标题", provider: "pi", sessionKind: "pty", status: "idle" },
  }));
  assert.match(html, /data-session-tabs="standalone"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /关闭并删除会话/);
  assert.doesNotMatch(html, /main-header-row/);
});

test("workbar removes page-link sharing without removing directory or ID actions", () => {
  const header = source("react/shell/shell-topbar.tsx");
  const actions = source("react/shell/workbar-actions.tsx");
  const native = readFileSync(new URL("../macos/Wand/MainShellView.swift", import.meta.url), "utf8");
  assert.doesNotMatch(header + actions, /CopyPageLink|copyLabel/);
  assert.match(header, /copy-cwd/);
  assert.match(header, /copy-session-id/);
  assert.doesNotMatch(native, /DesktopCopyPageLinkButton|private var shareURL/);
});

test("new-page and terminal measurement use the sole header owner", () => {
  const shell = source("react/shell/shell-main-content.tsx");
  const tabs = source("react/workspaces/workspace-tab-bar.tsx");
  const action = source("react/quick-terminal/action.tsx");
  const terminal = source("browser/terminal.ts");
  assert.match(shell, /!pageLayerOpen && <WorkspaceTabBar fallback=\{<ShellTopbar\/>\}/);
  assert.match(shell, /newWork\.open && !settings\.open && <NewSessionHeader\/>/);
  assert.doesNotMatch(tabs, /useEffect\(\(\) => \(\) => newSessionController\.close/);
  assert.match(action, /register\?\.\(owner\)/);
  assert.doesNotMatch(action, /setTopbarActive/);
  assert.match(terminal, /const chrome = host \|\| inline/);
  assert.match(terminal, /else reserveSpace\(height\)/);
});

test("unified workbar browser: routes, menus, cancel, stable content, docks, narrow and mobile", {
  skip: process.env.WAND_UNIFIED_WORKBAR_BROWSER !== "1", timeout: 120_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/unified-workbar-browser.mjs"], { encoding: "utf8", timeout: 110_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
