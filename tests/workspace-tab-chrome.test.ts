import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { WandUiMeasurementProvider } from "../src/web-ui/react/theme.js";
import { FirstStandaloneSessionChrome, FirstWorkspaceWindowChrome, WorkspaceMoreButton, WorkspaceTabBarChrome } from "../src/web-ui/react/workspaces/workspace-tab-chrome.js";
import { WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuTrigger } from "../src/web-ui/react/ui/index.js";

test("future first workspace window renders native task chrome without a live store", () => {
  for (const mobile of [true, false]) {
    const html = renderToString(React.createElement(WandUiMeasurementProvider, null,
      React.createElement(FirstWorkspaceWindowChrome, { mobile, taskName: "空任务", session: {
        id: "future-first-window", sessionKind: "pty", status: "running", provider: "codex", command: "codex", cwd: "/tmp/fixture",
      } })), { identifierPrefix: `future-${mobile ? "mobile" : "desktop"}-` });
    assert.match(html, /workspace-tab-bar/);
    assert.match(html, /wand-workspace-tabs/);
    assert.match(html, /任务 空任务 的工作窗口标签/);
    assert.match(html, /Codex 1/);
    assert.match(html, /workspace-tab-logo/);
    assert.match(html, /workspace-tab-dot/);
    assert.doesNotMatch(html, /topbar-git-badge|workspace-tab-git-badge|sessions-toggle-button/);
    if (mobile) {
      assert.match(html, /工作窗口操作/);
      assert.doesNotMatch(html, /workspace-tab-add|workspace-tab-files|workspace-tab-close/);
    } else {
      assert.match(html, /新建 Agent 或空白终端/);
      assert.match(html, /workspace-tab-files/);
      assert.match(html, /关闭任务标签组/);
      assert.doesNotMatch(html, /工作窗口操作|chat-width-toggle/);
    }
  }
});

test("pure workspace chrome preserves moving labels and controller action slots", () => {
  const html = renderToString(React.createElement(WandUiMeasurementProvider, null,
    React.createElement(WorkspaceTabBarChrome, { mobile: false, taskName: "任务", activeWindowId: "source", movingDir: "h",
      closingWindowId: "target", actions: React.createElement("span", { "data-fixture-actions": true }, "controller action slot"),
      windows: [{ id: "source", label: "当前终端", count: 1, containsMoving: true }, { id: "target", label: "目标窗口", count: 2 }] })),
  { identifierPrefix: "workspace-live-projection-" });
  assert.match(html, /moving-source/);
  assert.match(html, /move-target/);
  assert.match(html, /把当前终端移入「目标窗口」/);
  assert.match(html, /关闭工作窗口 目标窗口/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /移动终端并左右分屏/);
  assert.match(html, /选择目标窗口 · Esc 取消/);
  assert.match(html, /controller action slot/);
});

test("native workspace more trigger retains its owner class and cloned dropdown attributes", () => {
  const html = renderToString(React.createElement(WandUiMeasurementProvider, null,
    React.createElement(WandDropdownMenu, null,
      React.createElement(WandDropdownMenuTrigger, { render: React.createElement(WorkspaceMoreButton) }),
      React.createElement(WandDropdownMenuContent, { "aria-label": "工作窗口操作" },
        React.createElement(WandDropdownMenuItem, null, "新建 Agent 或空白终端")))), { identifierPrefix: "workspace-menu-owner-" });
  assert.match(html, /workspace-tab-more/);
  assert.match(html, /wand-ui-dropdown-trigger/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
});

test("ungrouped tabs reuse native chrome with add on both widths and retain task-only controls in task scope", () => {
  for (const mobile of [true, false]) {
    const html = renderToString(React.createElement(WandUiMeasurementProvider, null,
      React.createElement(FirstStandaloneSessionChrome, { mobile, session: {
        id: "unbound", title: "独立会话", command: "Shell", cwd: "/repo", status: "running",
      } })), { identifierPrefix: `standalone-${mobile}-` });
    assert.match(html, /data-session-tabs="standalone"/);
    assert.match(html, /未分组会话标签/);
    assert.match(html, /role="tab"/);
    assert.match(html, /独立会话/);
    assert.match(html, /workspace-tab-add/);
    assert.match(html, /在当前目录新建 Agent 或空白终端/);
    assert.doesNotMatch(html, /ant-tabs-tab-remove|workspace-tab-move|workspace-tab-close|workspace-tab-files|工作窗口操作/);
    if (mobile) assert.match(html, /width:44px;height:44px/);
  }
});
