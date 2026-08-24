import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activateTab,
  addTab,
  addTabAtPath,
  emptyLayout,
  moveTab,
  moveTabToPath,
  removeTab,
  sessionPane,
  setRatioAtPath,
  splitPane,
  splitPaneAtPath,
  taskSplitLayout,
  wrapInSplit,
} from "../src/web-ui/react/workspaces/layout-tree.js";
import {
  listSessionLabel,
  orderWorkspaceSessions,
  withLiveSessionTitle,
  workspaceSessionLabel,
  workspaceSessionProvider,
} from "../src/web-ui/react/workspaces/session-order.js";
import type { LayoutNode, PaneTab } from "../src/web-ui/react/workspaces/types.js";
import { WORKSPACE_AGENT_OPTIONS } from "../src/web-ui/react/workspaces/workspace-agent-dialog.js";
import {
  isDirectoryExpanded,
  isTaskSessionsExpanded,
  showsDirectoryDisclosure,
  showsTaskSessionDisclosure,
} from "../src/web-ui/react/workspaces/task-tree.js";
import {
  WorkspacesPanel,
  shortenWorkspacePath,
  workspacePathLeaf,
} from "../src/web-ui/react/workspaces/workspaces-panel.js";
import {
  HttpWorkspacesRepository,
  normalizeWorkspaceWorktreeOverview,
} from "../src/web-ui/react/workspaces/repository.js";
import {
  buildWorkspaceMergeAgentPrompt,
  workspaceWorktreeSummary,
} from "../src/web-ui/react/workspaces/workspace-worktree-model.js";
import { sessionPickerAndWorktreeStyles } from "../src/web-ui/react/styles/features.js";
import {
  activeWorkWindow,
  closeSessionPane,
  closeWorkWindow,
  extractSessionWindow,
  layoutSessionIds,
  moveSessionBeside,
  reconcileTaskWindowLayout,
  ungroupWorkWindow,
} from "../src/web-ui/react/workspaces/window-layout.js";

function sessionTab(id: string, sessionId = id): PaneTab {
  return { id, kind: "session", sessionId };
}

function paneTabs(node: LayoutNode): PaneTab[] {
  return node.type === "pane" ? node.tabs : [...paneTabs(node.children[0]), ...paneTabs(node.children[1])];
}

test("emptyLayout yields a single empty pane", () => {
  const layout = emptyLayout();
  assert.equal(layout.type, "pane");
  assert.deepEqual((layout as Extract<LayoutNode, { type: "pane" }>).tabs, []);
});

test("sessionPane keeps caller order and activates the requested session", () => {
  const layout = sessionPane(["a", "b", "c"], "b");
  if (layout.type !== "pane") throw new Error("expected pane");
  assert.deepEqual(layout.tabs.map((tab) => tab.kind === "session" ? tab.sessionId : ""), ["a", "b", "c"]);
  assert.equal(layout.active, 1);
});

test("taskSplitLayout moves the active session right and keeps the remaining tabs left", () => {
  const layout = taskSplitLayout(["a", "b", "c"], "b");
  if (layout.type !== "split") throw new Error("expected split");
  if (layout.children[0].type !== "pane" || layout.children[1].type !== "pane") {
    throw new Error("expected two panes");
  }
  assert.deepEqual(layout.children[0].tabs.map((tab) => tab.kind === "session" ? tab.sessionId : ""), ["a", "c"]);
  assert.deepEqual(layout.children[1].tabs.map((tab) => tab.kind === "session" ? tab.sessionId : ""), ["b"]);
  assert.equal(layout.children[1].active, 0);
});

test("taskSplitLayout keeps an empty sibling when there is only one session", () => {
  const layout = taskSplitLayout(["a"], "a");
  if (layout.type !== "split") throw new Error("expected split");
  assert.deepEqual(paneTabs(layout).map((tab) => tab.id), ["tab-a"]);
  assert.equal(layout.children[1].type, "pane");
  assert.deepEqual((layout.children[1] as Extract<LayoutNode, { type: "pane" }>).tabs, []);
});

test("list session labels skip titles that only repeat the directory or task name", () => {
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "wand", cwd: "/Users/me/wand" }, 0, ["wand"]),
    "Pi 1",
  );
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "重构会话恢复流程" }, 0, ["wand", "重构会话恢复流程"]),
    "Pi 1",
  );
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "修侧栏" }, 0, ["wand", "重构会话恢复流程"]),
    "修侧栏",
  );
});

test("workspace session labels ignore PTY cwd fallback titles and infer CLI from command", () => {
  assert.equal(
    workspaceSessionLabel({ id: "s1", provider: "claude", title: "wand", cwd: "/repo/wand" }, 0),
    "Claude 1",
  );
  assert.equal(workspaceSessionProvider({ command: "codex --search" }), "codex");
  assert.equal(
    workspaceSessionLabel({ id: "s2", command: "codex", title: "wand", cwd: "/repo/wand" }, 0),
    "Codex 1",
  );
  assert.equal(
    workspaceSessionLabel({ id: "s3", provider: "claude", title: "修权限弹窗" }, 1),
    "修权限弹窗",
  );
  assert.equal(
    listSessionLabel({ id: "s4", provider: "claude", title: "重构会话恢复流程" }, 0, ["重构会话恢复流程"]),
    "Claude 1",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s5", title: "Claude 1" }, "收紧 resume 时间窗").title,
    "收紧 resume 时间窗",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s6", title: "Claude 1" }, "claude").title,
    "Claude 1",
  );
});

test("workspace sessions use chronological tab order and stable labels", () => {
  const sessions = orderWorkspaceSessions([
    { id: "new", provider: "claude", startedAt: "2026-08-09T10:02:00.000Z" },
    { id: "old", provider: "claude", startedAt: "2026-08-09T10:00:00.000Z" },
    { id: "middle", provider: "claude", startedAt: "2026-08-09T10:01:00.000Z" },
  ]);
  assert.deepEqual(sessions.map((session) => session.id), ["old", "middle", "new"]);
  assert.deepEqual(sessions.map(workspaceSessionLabel), ["Claude 1", "Claude 2", "Claude 3"]);
});

test("new task conversations offer every supported Agent provider", () => {
  assert.deepEqual(
    WORKSPACE_AGENT_OPTIONS.map((option) => option.value),
    ["claude", "codex", "opencode", "grok", "qoder", "pi", "shell"],
  );
  assert.equal(WORKSPACE_AGENT_OPTIONS.at(-1)?.label, "空白终端");
  const source = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-agent-dialog.tsx", import.meta.url), "utf8");
  assert.match(source, /value: "structured".*智能对话模式/s);
  assert.match(source, /会话类型/);
});

test("opening an empty workspace task keeps creation user-driven", () => {
  const source = readFileSync(new URL("../src/web-ui/browser/workspaces-adapter.ts", import.meta.url), "utf8");
  const openTask = source.slice(source.indexOf("openTask(payload"), source.indexOf("newTaskSession(payload"));
  assert.match(openTask, /goHome\(\)/);
  assert.match(openTask, /reconcileTaskWindowLayout\(detail\.layout, \[\], null\)/);
  assert.doesNotMatch(openTask, /startSessionInCwd/);
});

test("workspaces panel steers creation to the empty-state CTA without manual refresh", () => {
  const html = renderToStaticMarkup(createElement(WorkspacesPanel));
  // 面板顶部不再有独立工具条；新建入口在空态 CTA（与底部主按钮、目录组「＋」并存）。
  assert.doesNotMatch(html, /workspaces-panel-toolbar|workspaces-panel-new-project/);
  assert.match(html, /aria-label="新建任务"/);
  assert.doesNotMatch(html, /刷新项目列表|workspaces-panel-refresh/);
});

test("workspace path captions keep the leaf and hide redundant absolute prefixes", () => {
  assert.equal(workspacePathLeaf("/Users/me/Self/vibe_coding/wand"), "wand");
  assert.equal(shortenWorkspacePath("/Users/me/Self/vibe_coding/wand"), "…/vibe_coding/wand");
  assert.equal(shortenWorkspacePath("/tmp/wand"), "/tmp/wand");
  assert.equal(shortenWorkspacePath("wand"), "wand");
});

test("task list treats directories as group headers and exposes per-terminal delete", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(panel, /workspace-row-count-label/);
  assert.match(panel, /删除终端/);
  assert.match(panel, /onDeleteSession/);
  assert.match(panel, /workspace-session-action delete/);
  assert.match(styles, /\.workspace-item\s*\{[^}]*border-radius:\s*12px/s);
  assert.match(styles, /\.workspace-tasks\s*\{[^}]*border-left/s);
  assert.match(styles, /\.workspace-task-name\s*\{[^}]*font-size:\s*var\(--font-size-sm\)/s);
  assert.match(styles, /\.workspace-task-name\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.doesNotMatch(panel, /isolated \? "隔离" : "共享"/);
  assert.match(styles, /\.workspace-session-main\s*\{[^}]*padding:\s*4px 6px 4px 12px/s);
  assert.match(styles, /\.workspace-session\.active > \.workspace-session-main::before\s*\{[^}]*left:\s*4px/s);
});

test("task session lists default to expanded so terminals stay visible after reload", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const \[collapsed, setCollapsed\] = React\.useState\(false\);\s*const \[confirming, setConfirming\]/);
  assert.match(panel, /canCollapseSessions && \(/);
  assert.equal(showsDirectoryDisclosure(1), false);
  assert.equal(showsDirectoryDisclosure(2), true);
  assert.equal(isDirectoryExpanded(true, 1), true);
  assert.equal(showsTaskSessionDisclosure(0), false);
  assert.equal(isTaskSessionsExpanded(true, 0), true);
  assert.equal(isTaskSessionsExpanded(true, 2), false);
  assert.equal(isTaskSessionsExpanded(false, 2), true);
});

test("task session rows and work-window tabs render each CLI logo", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const tabs = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-bar.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const processManager = readFileSync(new URL("../src/process-manager.ts", import.meta.url), "utf8");
  assert.match(panel, /SessionProviderMark session=\{session\}/);
  assert.match(tabs, /SessionProviderMark session=\{presentation\.session\}/);
  assert.match(tabs, /listSessionLabel\(meta\.session, meta\.index, parentNames\)/);
  assert.match(input, /index === 0 \|\| index === sequence\.length - 1/);
  assert.match(processManager, /shouldGenerateSessionTopicFromPtyInput\(view, shortcutKey\)/);
  assert.match(processManager, /provisionalSessionTopic\(prompt, blockedTitles\)/);
  const structured = readFileSync(new URL("../src/structured-session-manager.ts", import.meta.url), "utf8");
  assert.match(structured, /provisionalSessionTopic\(input, blockedTitles\)/);
});

test("new project dialog has shared dialog styling and a responsive provider grid", () => {
  assert.match(sessionPickerAndWorktreeStyles, /\.wand-new-project-providers\s*\{/);
  assert.match(sessionPickerAndWorktreeStyles, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(sessionPickerAndWorktreeStyles, /\.wand-new-project-provider:active\s*\{[^}]*scale\(0\.97\)/s);
});

test("workspace session order stays stable when timestamps are absent", () => {
  const sessions = orderWorkspaceSessions([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(sessions.map((session) => session.id), ["a", "b", "c"]);
});

test("each task terminal starts as its own work-window tab", () => {
  const layout = reconcileTaskWindowLayout(null, ["a", "b", "c"], "b");
  assert.equal(layout.windows.length, 3);
  assert.deepEqual(layout.windows.map((window) => layoutSessionIds(window.layout)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(layoutSessionIds(activeWorkWindow(layout)!.layout), ["b"]);
});

test("moving a terminal into another work window consumes its source tab", () => {
  const initial = reconcileTaskWindowLayout(null, ["a", "b", "c"], "a");
  const target = initial.windows.find((window) => layoutSessionIds(window.layout).includes("b"));
  assert.ok(target);
  const moved = moveSessionBeside(initial, "a", target.id, target.activeTabId, "h");
  assert.equal(moved.windows.length, 2);
  assert.deepEqual(layoutSessionIds(activeWorkWindow(moved)!.layout), ["b", "a"]);
  assert.equal(activeWorkWindow(moved)!.layout.type, "split");
});

test("a split terminal can move back out as a work-window tab", () => {
  const initial = reconcileTaskWindowLayout(null, ["a", "b", "c"], "a");
  const target = initial.windows.find((window) => layoutSessionIds(window.layout).includes("b"));
  assert.ok(target);
  const moved = moveSessionBeside(initial, "a", target.id, target.activeTabId, "v");
  const extracted = extractSessionWindow(moved, "a");
  assert.equal(extracted.windows.length, 3);
  assert.deepEqual(layoutSessionIds(activeWorkWindow(extracted)!.layout), ["a"]);
  assert.ok(extracted.windows.every((window) => window.layout.type === "pane"));
});

test("ungrouping a split promotes every pane to a top-level work-window tab", () => {
  const initial = reconcileTaskWindowLayout(null, ["a", "b", "c"], "a");
  const target = initial.windows.find((window) => layoutSessionIds(window.layout).includes("b"));
  assert.ok(target);
  const moved = moveSessionBeside(initial, "a", target.id, target.activeTabId, "h");
  const ungrouped = ungroupWorkWindow(moved, target.id);
  assert.equal(ungrouped.windows.length, 3);
  assert.deepEqual(ungrouped.windows.map((window) => layoutSessionIds(window.layout)).sort(), [["a"], ["b"], ["c"]].sort());
});

test("closing one split terminal collapses the window onto its sibling", () => {
  const initial = reconcileTaskWindowLayout(null, ["a", "b"], "a");
  const target = initial.windows.find((window) => layoutSessionIds(window.layout).includes("b"));
  assert.ok(target);
  const split = moveSessionBeside(initial, "a", target.id, target.activeTabId, "h");
  const closed = closeSessionPane(split, "a");
  assert.equal(closed.windows.length, 1);
  assert.equal(activeWorkWindow(closed)?.layout.type, "pane");
  assert.deepEqual(layoutSessionIds(activeWorkWindow(closed)!.layout), ["b"]);
});

test("closing an active work-window tab selects its left neighbour", () => {
  const initial = reconcileTaskWindowLayout(null, ["a", "b", "c"], "b");
  const active = activeWorkWindow(initial);
  assert.ok(active);
  const closed = closeWorkWindow(initial, active.id);
  assert.deepEqual(closed.windows.map((window) => layoutSessionIds(window.layout)), [["a"], ["c"]]);
  assert.deepEqual(layoutSessionIds(activeWorkWindow(closed)!.layout), ["a"]);
});

test("split terminals isolate xterm row redraws from the workspace page", () => {
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.ws-session-pane\s*\{[^}]*contain:\s*strict;[^}]*isolation:\s*isolate;/s);
});

test("workspace repository closes terminal sessions with the batch endpoint", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const repository = new HttpWorkspacesRepository(async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true, deleted: 2, failed: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await repository.deleteSessions(["a", "a", "b"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "/api/sessions/batch-delete");
  assert.equal(requests[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { sessionIds: ["a", "b"] });
});

test("workspace worktree review normalizes cards and builds one bounded merge Agent mission", async () => {
  const requests: string[] = [];
  const repository = new HttpWorkspacesRepository(async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      workspaceId: "workspace-1",
      repoRoot: "/repo",
      targetBranch: "main",
      worktrees: [{
        taskId: "task-1",
        taskName: "登录流程",
        taskStatus: "active",
        branch: "wand/login-1",
        path: "/repo/.wand-worktrees/login-1",
        state: "dirty",
        actionable: true,
        aheadCount: 2,
        hasUncommittedChanges: true,
        hasConflicts: false,
        commits: [{ hash: "abcdef123", subject: "feat: add login" }],
      }, {
        taskId: "task-empty",
        taskName: "已完成任务",
        branch: "wand/done-1",
        path: "/repo/.wand-worktrees/done-1",
        state: "empty",
        actionable: false,
        commits: [],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const overview = await repository.listWorktrees("workspace-1");
  assert.equal(requests[0], "/api/workspaces/workspace-1/worktrees");
  assert.equal(overview.worktrees[0].commits[0].shortHash, "abcdef1");
  assert.equal(workspaceWorktreeSummary(overview.worktrees[0]), "登录流程 · feat: add login");

  const prompt = buildWorkspaceMergeAgentPrompt({
    id: "workspace-1",
    name: "Wand",
    cwd: "/repo",
    layout: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    lastOpenedAt: null,
  }, overview, ["task-1", "task-empty"]);
  assert.match(prompt, /唯一目标分支：main/);
  assert.match(prompt, /wand\/login-1/);
  assert.doesNotMatch(prompt, /wand\/done-1/);
  assert.match(prompt, /不要 push，也不要删除 Worktree/);

  const normalized = normalizeWorkspaceWorktreeOverview({ worktrees: [{ branch: "missing task" }] });
  assert.deepEqual(normalized.worktrees, []);
});

test("project rows expose a worktree count bubble and a multi-select dialog", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const dialog = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-worktree-dialog.tsx", import.meta.url), "utf8");
  assert.match(panel, /workspace-row-action worktrees/);
  assert.match(panel, /startWorktreeMergeAgent/);
  assert.match(dialog, /role="checkbox"/);
  assert.match(dialog, /启动 Agent 合并/);
});

test("legacy pane tabsets migrate into independent work windows", () => {
  const legacy = sessionPane(["a", "b", "c"], "b");
  const migrated = reconcileTaskWindowLayout(legacy, ["a", "b", "c"], "b");
  assert.equal(migrated.windows.length, 3);
  assert.ok(migrated.windows.every((window) => layoutSessionIds(window.layout).length === 1));
});

test("addTab appends to the first pane and activates it", () => {
  const layout = addTab(addTab(emptyLayout(), sessionTab("a")), sessionTab("b"));
  const pane = layout as Extract<LayoutNode, { type: "pane" }>;
  assert.equal(pane.tabs.length, 2);
  assert.equal(pane.active, 1);
  assert.deepEqual(paneTabs(layout).map((tab) => tab.id), ["a", "b"]);
});

test("activateTab points the owning pane at the tab without touching others", () => {
  let layout = addTab(addTab(addTab(emptyLayout(), sessionTab("a")), sessionTab("b")), sessionTab("c"));
  layout = activateTab(layout, "a");
  const pane = layout as Extract<LayoutNode, { type: "pane" }>;
  assert.equal(pane.active, 0);
  // unknown id is a no-op
  assert.deepEqual(activateTab(layout, "missing"), layout);
});

test("wrapInSplit wraps a node with a sibling split", () => {
  const pane = addTab(emptyLayout(), sessionTab("a"));
  const split = wrapInSplit(pane, "h", emptyLayout(), 0.4);
  assert.equal(split.type, "split");
  if (split.type !== "split") throw new Error("expected split");
  assert.equal(split.dir, "h");
  assert.equal(split.ratio, 0.4);
  assert.equal(split.children[0], pane);
  assert.equal(split.children[1].type, "pane");
});

test("splitPane splits the first pane into a split with an empty sibling", () => {
  const layout = splitPane(addTab(emptyLayout(), sessionTab("a")), "v");
  assert.equal(layout.type, "split");
  if (layout.type !== "split") throw new Error("expected split");
  assert.equal(layout.dir, "v");
  assert.equal(layout.children[0].type, "pane");
  assert.equal((layout.children[1] as Extract<LayoutNode, { type: "pane" }>).tabs.length, 0);
  // original tab survives in the left child
  assert.deepEqual(paneTabs(layout).map((tab) => tab.id), ["a"]);
});

test("removeTab collapses a split when its pane becomes empty", () => {
  // split: [pane(a), pane()]  → removing a leaves empty root → collapses to single empty pane
  let layout: LayoutNode = splitPane(addTab(emptyLayout(), sessionTab("a")), "h");
  layout = removeTab(layout, "a");
  assert.equal(layout.type, "pane");
  assert.equal((layout as Extract<LayoutNode, { type: "pane" }>).tabs.length, 0);
});

test("removeTab keeps the sibling pane when one side still has tabs", () => {
  // [pane(a), pane(b)] → remove a → collapses to pane(b)
  let layout: LayoutNode = wrapInSplit(
    addTab(emptyLayout(), sessionTab("a")),
    "h",
    addTab(emptyLayout(), sessionTab("b")),
  );
  layout = removeTab(layout, "a");
  assert.equal(layout.type, "pane");
  assert.deepEqual(paneTabs(layout).map((tab) => tab.id), ["b"]);
});

test("removeTab re-clamps the active index after removal", () => {
  let layout: LayoutNode = addTab(addTab(addTab(emptyLayout(), sessionTab("a")), sessionTab("b")), sessionTab("c"));
  // active is on c (index 2); remove c → active must clamp back to 1 (b)
  layout = removeTab(layout, "c");
  const pane = layout as Extract<LayoutNode, { type: "pane" }>;
  assert.equal(pane.active, 1);
});

test("moveTab relocates a tab into the anchor pane and activates it", () => {
  // two panes: left [a], right [b]; move b into left pane anchored on a → left [a,b]
  let layout: LayoutNode = wrapInSplit(
    addTab(emptyLayout(), sessionTab("a")),
    "h",
    addTab(emptyLayout(), sessionTab("b")),
  );
  layout = moveTab(layout, "b", "a");
  // right pane is now empty → split collapses to the merged left pane
  assert.equal(layout.type, "pane");
  assert.deepEqual(paneTabs(layout).map((tab) => tab.id), ["a", "b"]);
  const pane = layout as Extract<LayoutNode, { type: "pane" }>;
  assert.equal(pane.active, 1);
});

test("moveTab is a no-op for unknown ids or moving onto itself", () => {
  const layout = addTab(emptyLayout(), sessionTab("a"));
  assert.equal(moveTab(layout, "a", "a"), layout);
  assert.equal(moveTab(layout, "missing", "a"), layout);
  assert.equal(moveTab(layout, "a", "missing"), layout);
});

test("moveTabToPath can drop a tab into an empty pane", () => {
  const layout = wrapInSplit(addTab(emptyLayout(), sessionTab("a")), "h", emptyLayout());
  const next = moveTabToPath(layout, "a", [1]);
  assert.equal(next.type, "split");
  if (next.type !== "split") throw new Error("expected split");
  assert.deepEqual((next.children[0] as Extract<LayoutNode, { type: "pane" }>).tabs, []);
  assert.deepEqual(paneTabs(next).map((tab) => tab.id), ["a"]);
});

test("operations are immutable: inputs are not mutated", () => {
  const original = addTab(emptyLayout(), sessionTab("a"));
  const snapshot = JSON.parse(JSON.stringify(original));
  splitPane(original, "h");
  removeTab(original, "a");
  activateTab(original, "a");
  assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
});

test("splitPaneAtPath splits the targeted pane, not the first one", () => {
  // root split: [pane(a), pane(b)] — split the RIGHT pane (path [1])
  const layout = wrapInSplit(
    addTab(emptyLayout(), sessionTab("a")),
    "h",
    addTab(emptyLayout(), sessionTab("b")),
  );
  const next = splitPaneAtPath(layout, [1], "v");
  // root stays a split; its right child is now itself a split containing b + empty
  assert.equal(next.type, "split");
  if (next.type !== "split") throw new Error("expected split");
  assert.equal(next.children[1].type, "split");
  // all original tabs survive somewhere in the tree
  assert.deepEqual(paneTabs(next).map((tab) => tab.id), ["a", "b"]);
});

test("splitPaneAtPath on the root pane (empty path) wraps it", () => {
  const layout = addTab(emptyLayout(), sessionTab("a"));
  const next = splitPaneAtPath(layout, [], "h");
  assert.equal(next.type, "split");
});

test("setRatioAtPath updates only the targeted split's ratio", () => {
  const layout = wrapInSplit(addTab(emptyLayout(), sessionTab("a")), "h", addTab(emptyLayout(), sessionTab("b")), 0.5);
  const next = setRatioAtPath(layout, [], 0.3);
  assert.equal(next.type, "split");
  if (next.type !== "split") throw new Error("expected split");
  assert.equal(next.ratio, 0.3);
});

test("addTabAtPath appends a tab to the targeted pane", () => {
  const layout = wrapInSplit(addTab(emptyLayout(), sessionTab("a")), "h", addTab(emptyLayout(), sessionTab("b")), 0.5);
  const next = addTabAtPath(layout, [1], sessionTab("c"));
  // right pane now has b, c and active points at c
  if (next.type !== "split") throw new Error("expected split");
  const right = next.children[1];
  if (right.type !== "pane") throw new Error("expected pane");
  assert.deepEqual(right.tabs.map((tab) => tab.id), ["b", "c"]);
  assert.equal(right.active, 1);
});
