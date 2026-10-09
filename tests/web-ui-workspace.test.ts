import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  activateTab,
  addTab,
  emptyLayout,
  moveTab,
  removeTab,
  setRatioAtPath,
  wrapInSplit,
} from "../src/web-ui/react/workspaces/layout-tree.js";
import {
  listSessionLabel,
  orderWorkspaceSessions,
  withLiveSessionTitle,
  workspaceSessionProvider,
} from "../src/web-ui/react/workspaces/session-order.js";
import type { LayoutNode, PaneTab } from "../src/web-ui/react/workspaces/types.js";
import { WORKSPACE_AGENT_OPTIONS } from "../src/web-ui/react/workspaces/workspace-agent-picker.js";
import {
  isDirectoryExpanded,
  isTaskSessionsExpanded,
  showsTaskSessionDisclosure,
} from "../src/web-ui/react/workspaces/task-tree.js";
import {
  CompactDirectoryRail,
  WorkspacesPanel,
  shortenWorkspacePath,
} from "../src/web-ui/react/workspaces/workspaces-panel.js";
import { SidebarDisclosure } from "../src/web-ui/react/workspaces/sidebar-disclosure.js";
import {
  formatTaskRecency,
  sidebarSelection,
  taskActivity,
} from "../src/web-ui/react/workspaces/sidebar-task-meta.js";
import type { TaskDirectoryGroup, TaskSummary } from "../src/web-ui/react/workspaces/types.js";
import {
  HttpWorkspacesRepository,
  normalizeWorkspaceWorktreeOverview,
} from "../src/web-ui/react/workspaces/repository.js";
import {
  buildWorkspaceMergeAgentBrief,
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

test("list session labels keep the session title even when it repeats the task name", () => {
  // 最新会话的标题常常正好等于任务首行（任务名由同一条消息生成）；
  // 之前这种「重复」会被退回「Pi 1」，把标题藏起来。
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "重构会话恢复流程" }, 0),
    "重构会话恢复流程",
  );
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "修侧栏" }, 0),
    "修侧栏",
  );
  // 旧版终端把 cwd 末段当标题，仍然不算会话标题。
  assert.equal(
    listSessionLabel({ id: "s1", provider: "pi", title: "wand", cwd: "/Users/me/wand" }, 0),
    "Pi 1",
  );
});

test("placeholder-only titles still fall back to 「CLI 序号」", () => {
  assert.equal(listSessionLabel({ id: "s1", provider: "pi", title: "会话" }, 0), "Pi 1");
  assert.equal(listSessionLabel({ id: "s1", provider: "pi", title: "pi" }, 0), "Pi 1");
  assert.equal(listSessionLabel({ id: "s1", provider: "pi", title: "Pi 1" }, 0), "Pi 1");
  assert.equal(listSessionLabel({ id: "s1", provider: "pi" }, 0), "Pi 1");
});

test("workspace session labels ignore PTY cwd fallback titles and infer CLI from command", () => {
  assert.equal(
    listSessionLabel({ id: "s1", provider: "claude", title: "wand", cwd: "/repo/wand" }, 0),
    "Claude 1",
  );
  assert.equal(workspaceSessionProvider({ command: "codex --search" }), "codex");
  assert.equal(
    listSessionLabel({ id: "s2", command: "codex", title: "wand", cwd: "/repo/wand" }, 0),
    "Codex 1",
  );
  assert.equal(
    listSessionLabel({ id: "s3", provider: "claude", title: "修权限弹窗" }, 1),
    "修权限弹窗",
  );
  assert.equal(
    listSessionLabel({ id: "s4", provider: "claude", title: "重构会话恢复流程" }, 0),
    "重构会话恢复流程",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s5", title: "Claude 1" }, "收紧 resume 时间窗").title,
    "收紧 resume 时间窗",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s6", title: "Claude 1" }, "claude").title,
    "Claude 1",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s7", title: "收紧 resume 时间窗", cwd: "/repo/wand" }, "wand").title,
    "收紧 resume 时间窗",
  );
  assert.equal(
    withLiveSessionTitle({ id: "s8", title: "收紧 resume 时间窗" }, "Claude 1").title,
    "收紧 resume 时间窗",
  );
});

test("workspace sessions use chronological tab order and stable labels", () => {
  const sessions = orderWorkspaceSessions([
    { id: "new", provider: "claude", startedAt: "2026-08-09T10:02:00.000Z" },
    { id: "old", provider: "claude", startedAt: "2026-08-09T10:00:00.000Z" },
    { id: "middle", provider: "claude", startedAt: "2026-08-09T10:01:00.000Z" },
  ]);
  assert.deepEqual(sessions.map((session) => session.id), ["old", "middle", "new"]);
});

test("new task conversations offer every supported Agent provider", () => {
  assert.deepEqual(
    WORKSPACE_AGENT_OPTIONS.map((option) => option.value),
    ["claude", "codex", "opencode", "grok", "qoder", "pi", "wand-agent", "gemini", "shell"],
  );
  assert.equal(WORKSPACE_AGENT_OPTIONS.at(-1)?.label, "空白终端");
  const source = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-agent-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /value: "structured", label: "对话"/);
  assert.match(source, /value: "pty", label: "终端"/);
  assert.match(source, /UnifiedExecutionSubjectPicker/);
  assert.match(readFileSync(new URL("../src/web-ui/react/workspaces/unified-execution-subject-picker.tsx", import.meta.url), "utf8"), /会话类型/);
});

test("opening an empty workspace task keeps creation user-driven", () => {
  const source = readFileSync(new URL("../src/web-ui/browser/workspaces-adapter.ts", import.meta.url), "utf8");
  const openTask = source.slice(source.indexOf("openTask(payload"), source.indexOf("newTaskSession(payload"));
  assert.match(openTask, /goHome\(\)/);
  assert.match(openTask, /const generation = \+\+openTaskGeneration/);
  assert.match(openTask, /if \(generation !== openTaskGeneration\) return;/);
  assert.match(openTask, /reconcileTaskWindowLayout\(detail\.layout, \[\], null\)/);
  assert.doesNotMatch(openTask, /startSessionInCwd/);
  const openWorkspace = source.slice(source.indexOf("openWorkspace(workspace"), source.indexOf("closeWorkspace()"));
  assert.match(openWorkspace, /goHome\(\)/);
  const newTaskSession = source.slice(source.indexOf("newTaskSession(payload"));
  assert.match(newTaskSession, /reconcileTaskWindowLayout\(current, \[\.\.\.existing, sessionId\], sessionId\)/);
});

test("empty task tab bar yields to the full-page CLI desktop", () => {
  const source = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-bar.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!context\.taskId\) return <StandaloneSessionTabBar\/>/);
  assert.match(source, /if \(taskLayout\.windows\.length === 0\) return null/);
  assert.doesNotMatch(source, /该任务还没有工作窗口/);
});

test("task tab bar and standalone topbar share one quick-commit badge", () => {
  const tabBar = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-bar.tsx", import.meta.url), "utf8");
  const tabChrome = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-chrome.tsx", import.meta.url), "utf8");
  const topbar = readFileSync(new URL("../src/web-ui/react/shell/shell-topbar.tsx", import.meta.url), "utf8");
  const badge = readFileSync(new URL("../src/web-ui/react/shell/topbar-git-badge.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  // 任务里主区顶部是标签栏而不是顶栏（ShellMainContent 在任务态不挂 ShellTopbar），
  // 徽章必须两个宿主都有，否则进任务后快捷提交入口就没了。
  assert.match(topbar, /gitBadge=\{<TopbarGitBadge\/>\}/);
  assert.match(topbar, /<span id=\{chromeId\("topbar-git-slot"\)\} className="topbar-git-slot">\s*\{gitBadge\}/);
  assert.doesNotMatch(topbar, /id="topbar-git-badge"/, "顶栏不再自带一份内联徽章");
  assert.match(tabBar, /<TopbarGitBadge id="workspace-tab-git-badge" className="workspace-tab-git"\/>/);
  assert.match(badge, /id = "topbar-git-badge"/, "默认保留顶栏的 DOM id");
  assert.match(badge, /dispatch\(\{ type: "topbar\.gitCommit" \}\)/);
  assert.match(badge, /if \(!git\) return null;/, "非 git 会话 / 首页不显示徽章");
  assert.match(tabBar, /<WorkspaceTabBarChrome mobile=\{mobile\} taskName=\{context.taskName\}/);
  assert.match(tabChrome, /<Flex align="center" gap=\{4\} wrap=\{!mobile\} className="workspace-tab-bar"/);
});

test("clicking a session inside the open task skips the task reopen", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  // 已在当前任务里：直接选中。再走 openTask 会先 goHome() 把正文清空、
  // 重新拉任务详情，回来还只选中布局里存的标签（点 A 先看到 B）。
  assert.match(panel, /if \(workspaceContextStore\.getSnapshot\(\)\.taskId === task\.id\) \{\s*rt\.selectSession\(session\.id\);\s*return;\s*\}/);
  // 跨任务：把点的那一个会话作为恢复目标，恢复出来就是它，不再等二次选择。
  assert.match(panel, /openTask\(group, task, session\.id\)/);
  assert.match(panel, /const openTask = React\.useCallback\(\(group: TaskDirectoryGroup, task: TaskSummary, preferredSessionId\?: string\)/);
});

test("new task dialog unifies through newSessionController to eliminate duplicate dialogs", () => {
  const host = readFileSync(new URL("../src/web-ui/react/workspaces/host.tsx", import.meta.url), "utf8");
  assert.match(host, /newSessionController\.open/);
  assert.match(host, /workspacesStore\.consumeOpen/);
  assert.doesNotMatch(host, /workspacesController\.close/, "handoff must not immediately close the new form");
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /newSessionController\.open\(\{\s*initialCwd: group\.global \? undefined : group\.workspaceCwd,/);
});

test("workspaces panel waits for the first read before offering its business empty CTA", () => {
  const html = renderToStaticMarkup(createElement(WorkspacesPanel));
  assert.doesNotMatch(html, /workspaces-panel-toolbar|workspaces-panel-new-project/);
  assert.match(html, /aria-label="正在加载任务列表"/);
  assert.doesNotMatch(html, /开始一个任务|还没有对话/);
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /className="workspaces-empty-action" aria-label="新建会话"/);
  assert.doesNotMatch(html, /刷新项目列表|workspaces-panel-refresh/);
});

test("sidebar disclosure keeps content mounted but inert when collapsed", () => {
  const collapsed = renderToStaticMarkup(createElement(SidebarDisclosure, {
    id: "task-terminals", open: false, children: createElement("button", null, "终端"),
  }));
  assert.match(collapsed, /data-open="false" inert="" aria-hidden="true"/);
  assert.match(collapsed, /<button>终端<\/button>/);
  const expanded = renderToStaticMarkup(createElement(SidebarDisclosure, {
    id: "task-terminals", open: true, children: "终端",
  }));
  assert.doesNotMatch(expanded, /inert=/);
  assert.match(expanded, /data-open="true" aria-hidden="false"/);
});

test("task recency handles minute, hour, day, invalid and future timestamps", () => {
  const now = new Date(2026, 8, 8, 12).getTime();
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();
  assert.equal(formatTaskRecency(ago(0), now), "刚刚");
  assert.equal(formatTaskRecency(ago(-10), now), "刚刚");
  assert.equal(formatTaskRecency(ago(59), now), "59分");
  assert.equal(formatTaskRecency(ago(60), now), "1时");
  assert.equal(formatTaskRecency(ago(1_440), now), "1天");
  assert.equal(formatTaskRecency(ago(10_080), now), "9/1");
  assert.equal(formatTaskRecency(new Date(2025, 11, 1).toISOString(), now), "2025/12/1");
  assert.equal(formatTaskRecency("not-a-date", now), "");
});

test("task activity reflects live turns, not merely a running shell process", () => {
  const task: TaskSummary = {
    id: "task", workspaceId: "workspace", name: "任务", cwd: "/workspace", worktree: null,
    layout: null, status: "active", isolated: false, createdAt: "", lastOpenedAt: null, sessions: [],
  };
  assert.equal(taskActivity(task), null);
  assert.equal(taskActivity({ ...task, sessions: [{ id: "shell", status: "running" }] }), null);
  assert.equal(taskActivity({ ...task, sessions: [{ id: "pty", ptyBusy: true }] }), "running");
  assert.equal(taskActivity({ ...task, sessions: [{ id: "structured", inFlight: true }] }), "running");
  assert.equal(taskActivity({ ...task, sessions: [
    { id: "busy", inFlight: true }, { id: "failed", status: "failed" },
  ] }), "attention");
});

test("sidebar restores task selection from a selected session without overriding an explicit workspace", () => {
  const groups: TaskDirectoryGroup[] = [{
    workspaceId: "global", workspaceName: "独立任务", workspaceCwd: "/scratch", global: true,
    standaloneSessions: [{ id: "loose" }],
    tasks: [{
      id: "task", workspaceId: "global", name: "任务", cwd: "/scratch", worktree: null,
      layout: null, status: "active", isolated: false, createdAt: "", lastOpenedAt: null,
      sessions: [{ id: "terminal" }],
    }],
  }];
  const empty = { workspaceId: null, taskId: null };
  assert.deepEqual(sidebarSelection(groups, empty, "terminal"), { workspaceId: "global", taskId: "task" });
  assert.deepEqual(sidebarSelection(groups, empty, "loose"), { workspaceId: "global", taskId: null });
  assert.deepEqual(sidebarSelection(groups, empty, "missing"), empty);
  assert.deepEqual(sidebarSelection(groups, { workspaceId: "other", taskId: null }, "terminal"), {
    workspaceId: "other", taskId: null,
  });
});

test("new task dialog follows the selected directory through newSessionController", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /newSessionController\.open\(\{\s*initialCwd: group\.global \? undefined : group\.workspaceCwd,/);
  const commands = readFileSync(new URL("../src/web-ui/browser/shell-commands.ts", import.meta.url), "utf8");
  assert.match(commands, /openNewProject: \(cwd\) => openSessionModal\(cwd\)/);
});

test("new task dialog no longer exposes a project creation view", () => {
  const host = readFileSync(new URL("../src/web-ui/react/workspaces/host.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(host, /setCreationKind/);
  assert.doesNotMatch(host, /creationKind === "project"/);
});

test("workspace path captions keep the leaf and hide redundant absolute prefixes", () => {
  assert.equal(shortenWorkspacePath("/Users/me/Self/vibe_coding/wand"), "…/vibe_coding/wand");
  assert.equal(shortenWorkspacePath("/tmp/wand"), "/tmp/wand");
  assert.equal(shortenWorkspacePath("wand"), "wand");
});

test("task list treats directories as group headers and exposes per-terminal delete", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /workspaces-overview/);
  assert.match(panel, /workspace-row-count/);
  assert.match(panel, /删除终端/);
  assert.match(panel, /onDeleteSession/);
  assert.match(panel, /<SidebarSessionMenu row=\{row\}/);
  assert.doesNotMatch(panel, /workspace-session-action more/);
  assert.match(panel, /<Flex vertical gap=\{4\} style=\{\{ paddingInlineStart: 8 \}\} className="workspace-tasks"/);
  // Row chrome (cursor, padding, hover wash) is Appica's NavigationLink now;
  // Wand keeps the identity hook so the shell can still find the row.
  assert.match(panel, /className="workspace-task-main"/);
  assert.match(panel, /minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
  assert.match(panel, /workspace-task-count/);
  assert.match(panel, /className="workspace-task-menu"/);
  assert.match(panel, /删除目录/);
  assert.match(panel, /handleDeleteDirectory/);
  assert.match(panel, /danger: true[^\n]*label: "删除目录…"/);
  assert.doesNotMatch(panel, /role="button"[\s\S]{0,500}workspace-task-action/);
  assert.doesNotMatch(panel, /isolated \? "隔离" : "共享"/);
  assert.doesNotMatch(panel, /if \(!collapsible\) return/);
  assert.doesNotMatch(panel, /is-static/);

  // Library row chrome remains; destructive actions live in the menu with explicit confirmation.
  assert.match(panel, /className="workspace-session-main"/);
  assert.match(panel, /<Flex align="center" gap=\{4\} style=\{\{ minWidth: 0, width: "100%" \}\} className=\{classNames\(/);
  const sessionMenu = readFileSync(new URL("../src/web-ui/react/workspaces/sidebar-session-menu.tsx", import.meta.url), "utf8");
  assert.match(sessionMenu, /className="workspace-session-menu"/);
  assert.doesNotMatch(panel, /workspace-row-folder|workspace-task-marker/);
  assert.match(sessionMenu, /confirmSessionDelete/);
  assert.match(panel, /confirmClearSessions\(key === "clear" \? totalSessionCount : teamSplit.history.length/,
    "clearing a task must count team sessions too; its delete scope includes them");
  // 删除确认只有一个来源：公共确认模块，各列表不再各写一套内联确认。
  const sessionDelete = readFileSync(new URL("../src/web-ui/react/workspaces/session-delete-confirm.ts", import.meta.url), "utf8");
  assert.match(sessionDelete, /无法撤销。任务和其他会话保留/);
  const tabs = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-bar.tsx", import.meta.url), "utf8");
  const tabChrome = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-chrome.tsx", import.meta.url), "utf8");
  assert.match(tabChrome, /type="editable-card"/);
  assert.match(tabChrome, /onEdit=/);
  assert.match(tabChrome, /aria-label=\{standalone \? "未分组会话标签" : `任务 \$\{taskName\} 的工作窗口标签`\}/);
  assert.match(tabs, /<WorkspaceTabBarChrome mobile=\{mobile\} taskName=\{context.taskName\}/);
});

test("task sessions prioritize the active or only task and standalone sessions have no fake task fold", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /useSidebarExpansion\(\s*`task\.\$\{task.id\}`, true, false, isActive \|\| isOnlyTask/);
  assert.match(panel, /useSidebarExpansion\(`project\.\$\{group.workspaceId\}`, false, true\)/);
  assert.doesNotMatch(panel, /useSidebarExpansion\(`loose\./);
  assert.match(panel, /aria-label="独立会话"/);
  assert.doesNotMatch(panel, /orderSidebarTasks\(group.tasks\)/);
  assert.match(panel, /group\.tasks\.map\(\(task\)/);
  assert.doesNotMatch(panel, /taskRecency\(right\)\.localeCompare\(taskRecency\(left\)\)/);
  assert.doesNotMatch(panel, /if \(isActive\) setCollapsed|setCollapsed\(false\); onOpen/);
  assert.match(panel, /anchorSidebarDisclosure\(event.currentTarget, toggleSessionsOpen\)/);
  assert.equal(isDirectoryExpanded(true, 1), false);
  assert.equal(isDirectoryExpanded(false, 1), true);
  assert.equal(showsTaskSessionDisclosure(0), false);
  assert.equal(isTaskSessionsExpanded(true, 0), false);
  assert.equal(isTaskSessionsExpanded(false, 0, true), true);
  assert.equal(isTaskSessionsExpanded(true, 2), false);
  assert.equal(isTaskSessionsExpanded(false, 2), true);
});

test("task session rows and work-window tabs render each CLI logo", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const tabs = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-bar.tsx", import.meta.url), "utf8");
  const tabChrome = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-tab-chrome.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const processManager = readFileSync(new URL("../src/process-manager.ts", import.meta.url), "utf8");
  assert.match(panel, /SessionProviderMark session=\{session\}/);
  assert.match(tabChrome, /SessionProviderMark session=\{presentation\.session\}/);
  assert.match(tabs, /listSessionLabel\(meta\.session, meta\.index\)/);
  assert.match(input, /index === 0 \|\| index === sequence\.length - 1/);
  assert.match(processManager, /consumePtyInputForTopic\(record\.ptyTopicDraft, input, view, shortcutKey\)/);
  assert.match(processManager, /provisionalSessionTopic\(prompt, blockedTitles\)/);
  assert.match(processManager, /type: "status", sessionId: id, data: \{ title, description, summary: description \}/);
  const websocket = readFileSync(new URL("../src/web-ui/browser/websocket.ts", import.meta.url), "utf8");
  assert.match(websocket, /!topicMetadataChanged/);
  assert.match(websocket, /statusUpdate\.title = msg\.data\.title/);
  const structured = readFileSync(new URL("../src/structured-session-manager.ts", import.meta.url), "utf8");
  assert.match(structured, /provisionalSessionTopic\(input, blockedTitles\)/);
});

test("new task dialog delegates project suggestions and controls to the library", () => {
  const newSessionHost = readFileSync(new URL("../src/web-ui/react/new-session/host.tsx", import.meta.url), "utf8");
  assert.match(newSessionHost, /<AutoComplete/);
  assert.match(newSessionHost, /<Collapse/);
  assert.match(newSessionHost, /<TaskForm/);
  assert.doesNotMatch(sessionPickerAndWorktreeStyles, /wand-new-project-providers/);
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
  const window = sourceText("src/web-ui/react/workspaces/workspace-window.tsx");
  assert.match(window, /contain: "strict", isolation: "isolate"/);
  assert.match(window, /<Splitter/);
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

test("workspace repository renames a directory through the session-directory endpoint", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const repository = new HttpWorkspacesRepository(async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ ok: true, path: "/repo", name: "核心工作区" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await repository.renameDirectory("/repo", "核心工作区");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "/api/session-directories/name");
  assert.equal(requests[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { path: "/repo", name: "核心工作区" });

  // 空名 = 恢复目录名，仍要发出去（服务端会清掉自定义名并回退项目名）。
  await repository.renameDirectory("/repo", null);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { path: "/repo", name: null });
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

  const brief = buildWorkspaceMergeAgentBrief({
    id: "workspace-1",
    name: "Wand",
    cwd: "/repo",
    layout: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    lastOpenedAt: null,
  }, overview, ["task-1", "task-empty"]);
  // 角色与规则进系统提示，清单这类本次内容进用户消息。
  assert.match(brief.system, /唯一目标分支：main/);
  assert.match(brief.system, /不要 push，也不要删除 Worktree/);
  assert.match(brief.message, /wand\/login-1/);
  assert.doesNotMatch(brief.message, /wand\/done-1/);
  assert.doesNotMatch(brief.message, /执行要求/, "rules stay out of the user message");

  const normalized = normalizeWorkspaceWorktreeOverview({ worktrees: [{ branch: "missing task" }] });
  assert.deepEqual(normalized.worktrees, []);
});

test("project menus retain worktree management and a multi-select dialog", () => {
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  const dialog = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-worktree-dialog.tsx", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("../src/web-ui/browser/workspaces-adapter.ts", import.meta.url), "utf8");
  assert.match(panel, /查看并合并 Worktree/);
  assert.match(panel, /startWorktreeMergeAgent/);
  assert.match(dialog, /<Checkbox[\s\S]*?checked=\{selected\}/);
  assert.match(dialog, /启动 Agent 合并/);
  // 合并 Agent 的角色与规则走系统提示，不能和清单一起拼成首条用户消息。
  assert.match(panel, /systemPrompt: brief\.system/);
  assert.match(panel, /prompt: brief\.message/);
  assert.match(adapter, /systemPrompt: payload\.systemPrompt/);
});

test("legacy pane tabsets migrate into independent work windows", () => {
  const legacy: LayoutNode = { type: "pane", active: 1, tabs: ["a", "b", "c"].map(sessionTab) };
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

test("removeTab collapses a split when its pane becomes empty", () => {
  // split: [pane(a), pane()]  → removing a leaves empty root → collapses to single empty pane
  let layout: LayoutNode = wrapInSplit(addTab(emptyLayout(), sessionTab("a")), "h", emptyLayout());
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

test("operations are immutable: inputs are not mutated", () => {
  const original = addTab(emptyLayout(), sessionTab("a"));
  const snapshot = JSON.parse(JSON.stringify(original));
  removeTab(original, "a");
  activateTab(original, "a");
  assert.deepEqual(JSON.parse(JSON.stringify(original)), snapshot);
});

test("setRatioAtPath updates only the targeted split's ratio", () => {
  const layout = wrapInSplit(addTab(emptyLayout(), sessionTab("a")), "h", addTab(emptyLayout(), sessionTab("b")), 0.5);
  const next = setRatioAtPath(layout, [], 0.3);
  assert.equal(next.type, "split");
  if (next.type !== "split") throw new Error("expected split");
  assert.equal(next.ratio, 0.3);
});

test("sidebar search keeps matching tasks and sessions while preserving directory scope", async () => {
  const { filterSidebarGroups } = await import("../src/web-ui/react/workspaces/sidebar-search.js");
  const groups = [{
    workspaceId: "workspace-1", workspaceName: "Wand", workspaceCwd: "/work/wand",
    tasks: [{
      id: "task-1", workspaceId: "workspace-1", name: "修复侧栏", cwd: "/work/wand",
      worktree: null, isolated: false, layout: null, status: "active" as const,
      createdAt: "2026-09-09T00:00:00Z", lastOpenedAt: null,
      sessions: [{ id: "session-1", title: "移动端检查", cwd: "/work/wand", provider: "claude", sessionKind: "structured" as const }],
    }], standaloneSessions: [],
  }];
  const result = filterSidebarGroups(groups, "移动端", { "session-1": "移动端检查" });
  assert.equal(result.length, 1);
  assert.equal(result[0].tasks.length, 1);
  assert.equal(filterSidebarGroups(groups, "不存在").length, 0);
});

function manageTask(
  id: string,
  name: string,
  sessions: Array<{ id: string }> = [],
  lastOpenedAt: string | null = null,
) {
  return {
    id,
    workspaceId: "workspace-1",
    name,
    cwd: "/work",
    worktree: null,
    isolated: false,
    layout: null,
    status: "active" as const,
    createdAt: "2026-09-09T00:00:00Z",
    lastOpenedAt,
    sessions,
  };
}

test("sidebar multi-select archives tasks and only deletes the terminals that were picked", async () => {
  const {
    EMPTY_SIDEBAR_MANAGE_SELECTION,
    collectManagedIds,
    isManagedGroupSelected,
    toggleManagedGroup,
    describeManagedAction,
    describeManagedResult,
    pruneManagedSelection,
    sidebarManageCount,
    toggleManagedSession,
    toggleManagedTask,
  } = await import("../src/web-ui/react/workspaces/sidebar-manage.js");
  const groups = [{
    workspaceId: "workspace-1",
    workspaceName: "Wand",
    workspaceCwd: "/work",
    tasks: [
      manageTask("task-1", "修复侧栏", [{ id: "session-1" }, { id: "session-2" }]),
      manageTask("task-2", "文档", [{ id: "session-3" }]),
    ],
    standaloneSessions: [{ id: "loose-1" }],
  }];
  let selection = toggleManagedTask(EMPTY_SIDEBAR_MANAGE_SELECTION, "task-1");
  selection = toggleManagedSession(selection, "session-1");
  selection = toggleManagedSession(selection, "loose-1");
  assert.equal(sidebarManageCount(selection), 3);
  // 归档任务不会连带它的终端：只有显式选中的 session-1 / loose-1 会被删除。
  assert.deepEqual([...selection.taskIds], ["task-1"]);
  assert.deepEqual([...selection.sessionIds], ["session-1", "loose-1"]);
  assert.equal(describeManagedAction(selection), "归档任务并归档终端");
  assert.equal(describeManagedAction({ taskIds: ["task-1"], sessionIds: [] }), "归档任务");
  assert.equal(describeManagedAction({ taskIds: [], sessionIds: ["session-1"] }), "归档终端");
  assert.equal(describeManagedResult(selection), "归档 1 个任务、归档 2 个终端");
  const pruned = pruneManagedSelection({
    taskIds: ["task-1", "gone"],
    sessionIds: ["session-1", "missing"],
  }, groups);
  assert.deepEqual([...pruned.taskIds], ["task-1"]);
  assert.deepEqual([...pruned.sessionIds], ["session-1"]);
  const all = collectManagedIds(groups);
  assert.equal(all.taskIds.length, 2);
  assert.equal(all.sessionIds.length, 4);
  const other = {
    ...groups[0], workspaceId: "workspace-2",
    tasks: [manageTask("other", "其他", [])], standaloneSessions: [],
  };
  const firstGroup = toggleManagedGroup({ taskIds: ["other"], sessionIds: [] }, groups[0]);
  assert.equal(isManagedGroupSelected(firstGroup, groups[0]), true);
  assert.deepEqual(firstGroup.taskIds, ["other", "task-1", "task-2"]);
  assert.equal(isManagedGroupSelected(firstGroup, other), true);
  const clearedGroup = toggleManagedGroup(firstGroup, groups[0]);
  assert.deepEqual(clearedGroup, { taskIds: ["other"], sessionIds: [] });
  assert.equal(isManagedGroupSelected(clearedGroup, groups[0]), false);
  const partiallySelected = toggleManagedGroup({ taskIds: ["task-1"], sessionIds: [] }, groups[0]);
  assert.deepEqual(partiallySelected.taskIds, ["task-1", "task-2"]);
});

test("compact rail shows every directory, including empty ones, without task entries", () => {
  const groups = Array.from({ length: 10 }, (_, index) => ({
    workspaceId: `directory-${index}`,
    workspaceName: `项目 ${index}`,
    workspaceCwd: `/work/${index}`,
    tasks: index === 0 ? [manageTask("task", "TASK-MUST-NOT-BE-IN-RAIL", [])] : [],
    standaloneSessions: [],
  }));
  const html = renderToStaticMarkup(createElement(CompactDirectoryRail, {
    groups,
    loading: false,
    error: "",
    activeWorkspaceId: "directory-0",
    peekDirectoryId: "directory-9",
    onExpand: () => {},
  }));
  assert.equal((html.match(/data-sidebar-directory-id=/g) ?? []).length, 10);
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.match(html, /aria-label="查看目录 项目 9" aria-expanded="true"/);
  assert.match(html, /aria-controls="sidebar-peek"/);
  assert.doesNotMatch(html, /TASK-MUST-NOT-BE-IN-RAIL|sidebar-collapsed-rail-more/);
});

test("workspaces panel exposes multi-select and a compact directory rail", () => {
  const html = renderToStaticMarkup(createElement(WorkspacesPanel));
  assert.match(html, /aria-label="会话列表选项"/);
  assert.match(html, /title="列表选项"/);
  assert.match(html, /sidebar-list-title[^>]*><strong>执行会话<\/strong>/);
  const panel = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /CompactDirectoryRail/);
  assert.match(panel, /groups=\{visibleGroups\}/);
  assert.match(panel, /workspace-global-tasks/);
  assert.match(panel, /onToggleGroup=/);
  assert.match(panel, /data-sidebar-directory-id=\{group.workspaceId\}/);
  assert.match(panel, /sidebar-collapsed-rail/);
  assert.doesNotMatch(panel, /CompactWorkspaceTree/);
  assert.doesNotMatch(panel, /sidebar-collapsed-task-branch/);
  // 目录行提供重命名入口，且走统一的目录改名接口（服务端会同步项目名）。
  assert.match(panel, /重命名目录/);
  assert.match(panel, /renameDirectory\(group\.workspaceCwd/);
});

test("directory previews omit global toolbar and unrelated history groups", () => {
  const html = renderToStaticMarkup(createElement(WorkspacesPanel, {
    directoryId: "workspace-one",
    extraGroups: createElement("span", null, "UNRELATED-HISTORY"),
  }));
  assert.doesNotMatch(html, /UNRELATED-HISTORY|项目与任务|多选任务和终端|搜索任务或会话/);
});

test("unnamed tasks keep their own sidebar row instead of folding into loose sessions", async () => {
  // 侧栏是「目录 → 任务 → 终端」三级：未命名任务也是任务容器，服务端兜底名照样显示一行。
  const { findSessionTask } = await import("../src/web-ui/react/workspaces/session-task-lookup.js");
  const group = {
    workspaceId: "w1",
    workspaceName: "Wand",
    workspaceCwd: "/work",
    tasks: [
      manageTask("named", "修复侧栏", [{ id: "named-session" }]),
      manageTask("unnamed-1", "未命名任务", [{ id: "loose-a" }]),
    ],
    standaloneSessions: [{ id: "loose-0" }],
  };
  assert.equal(findSessionTask(group, { id: "named-session" })?.id, "named");
  assert.equal(findSessionTask(group, { id: "loose-a" })?.id, "unnamed-1");
  assert.equal(findSessionTask(group, { id: "missing" }), undefined);
  // 目录预览只渲染一个目录的切片，会话要靠 workspaceTaskId 回到原始分组找任务。
  const preview = { ...group, tasks: [], standaloneSessions: [{ id: "loose-a", workspaceTaskId: "unnamed-1" }] };
  assert.equal(findSessionTask(preview, { id: "loose-a", workspaceTaskId: "unnamed-1" }, [group])?.id, "unnamed-1");
  // 会话丢了 taskId 时退化成按 session id 在原始分组里找。
  assert.equal(findSessionTask(preview, { id: "loose-a" }, [group])?.id, "unnamed-1");
});

/** Read a repository file relative to the test directory. */
function sourceText(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("sidebar directory tree indents every level without extra re-renders", () => {
  const layout = sourceText("src/web-ui/react/workspaces/workspaces-panel.tsx");
  // Flex explicitly indents task children and session children past their parent.
  assert.match(layout, /paddingInlineStart: 8.*className="workspace-tasks"/);
  assert.match(layout, /paddingInlineStart: 12.*className="workspace-task-sessions"/);
  assert.match(layout, /paddingInlineStart: 12.*className="workspace-team-fold-list"/);

  // The /api/tasks poll hands back fresh objects every few seconds; folding must
  // be memoized by content or 40-session directories re-render on a timer.
  const panel = sourceText("src/web-ui/react/workspaces/workspaces-panel.tsx");
  assert.match(panel, /const groups = sourceGroups/);
  assert.doesNotMatch(panel, /createUnnamedTaskFlattener/);
  assert.match(panel, /useTaskGroups\(refreshTick\)/);
  const directoryStore = sourceText("src/web-ui/react/workspaces/task-groups-store.ts");
  assert.match(directoryStore, /subscribeTaskChanges/);
});

test("workspaces controller keeps the dialog state stable while submitting", async () => {
  const runtime = {
    onOpen: () => {},
    onClose: () => {},
    openTask: () => {},
    newTaskSession: () => {},
    refreshSessions: () => {},
    toast: () => {},
    openSession: () => {},
    saveTaskLayout: () => {},
  };
  const { workspacesController, workspacesStore, configureWorkspacesRuntime } = await import(
    "../src/web-ui/react/workspaces/controller.js"
  );
  const uninstall = configureWorkspacesRuntime(runtime as never);
  try {
    const revisions: number[] = [];
    const unsubscribe = workspacesStore.subscribe(() => {
      revisions.push(workspacesStore.getSnapshot().revision);
    });

    assert.equal(workspacesController.open("/workspace/project"), true);
    const openRevision = workspacesStore.getSnapshot().revision;
    assert.equal(workspacesStore.getSnapshot().initialCwd, "/workspace/project");

    // 提交期间锁住/恢复 dismissable 都不是新的打开生命周期：revision 必须保持
    // 稳定，否则 Host 初始化 effect 会重放，把用户选定的目录等表单状态清掉。
    workspacesController.setDismissable(false);
    assert.equal(workspacesStore.getSnapshot().dismissable, false);
    assert.equal(workspacesController.closeIfOpen(), false);
    workspacesController.setDismissable(true);
    assert.equal(workspacesStore.getSnapshot().dismissable, true);
    assert.equal(workspacesStore.getSnapshot().revision, openRevision,
      "dismissability toggles must not replay the new-task dialog initialization");

    assert.equal(workspacesController.closeIfOpen(), true);
    assert.equal(workspacesController.isOpen(), false);
    assert.equal(revisions.length, 4, "open, lock, unlock, close each notify once");
    assert.equal(revisions[1], openRevision, "locking must not replay initialization");
    assert.equal(revisions[2], openRevision, "unlocking must not replay initialization");
    assert.equal(revisions[3], openRevision + 1, "only close bumps the lifecycle revision");

    unsubscribe();
  } finally {
    uninstall();
  }
});

test("legacy workspace handoff consumes its request without closing or reinitializing the canonical session form", async () => {
  const { workspacesController, workspacesStore } = await import("../src/web-ui/react/workspaces/controller.js");
  const { newSessionController, newSessionStore, configureNewSessionRuntime } = await import("../src/web-ui/react/new-session/controller.js");
  const uninstall = configureNewSessionRuntime({ onOpen() {}, onClose() {} } as never);
  try {
    workspacesController.open("/workspace/handed-off");
    const revision = newSessionStore.getSnapshot().revision;
    workspacesStore.consumeOpen();
    assert.equal(workspacesStore.getSnapshot().open, false);
    assert.equal(newSessionController.isOpen(), true);
    assert.equal(newSessionStore.getSnapshot().initialCwd, "/workspace/handed-off");
    assert.equal(newSessionStore.getSnapshot().revision, revision, "handoff keeps all live form choices");
    assert.equal(workspacesController.isOpen(), true, "compatibility API still sees the canonical form");
    newSessionController.close();
    assert.equal(workspacesController.isOpen(), false);
  } finally { uninstall(); }
});

test("danger 语义不再被静默降级，批量失败的原因留在原位", () => {
  const overlays = readFileSync(
    new URL("../src/web-ui/react/legacy-overlays.ts", import.meta.url),
    "utf8",
  );
  // 调用方（workspaces-adapter）沿用的是 dialog 那套词表里的 "danger"，
  // toastTone 之前不认它 → 落到 info（不报错、不变红、4s 也没有），属静默降级。
  assert.equal((overlays.match(/case "danger":\n\s*return "error";/g) ?? []).length, 1);
  assert.match(overlays, /function toastTone\(value: unknown\): WandToastTone \{[\s\S]*?case "danger":[\s\S]*?return "error";/);
  const adapter = readFileSync(
    new URL("../src/web-ui/browser/workspaces-adapter.ts", import.meta.url),
    "utf8",
  );
  // 现在真正吃到这条修正的 danger 调用点（两处都是错误语义）。
  assert.equal((adapter.match(/showToast\([\s\S]{0,160}, "danger"\);/g) ?? []).length, 2);

  const notifications = readFileSync(
    new URL("../src/web-ui/browser/notifications.ts", import.meta.url),
    "utf8",
  );
  // danger 与 error 同等待遇（4s 驻留）；气泡通道只有 info/warning/success 三个 class，
  // 所以回退路径仍把错误压成 warning，但 success 不再被压成 info。
  assert.match(notifications, /var isError = type === "error" \|\| type === "danger";/);
  assert.match(notifications, /var duration = isError \? 4000 : 2200;/);
  assert.match(notifications, /type: isError \? "warning" : type === "success" \? "success" : "info",/);
});

test("批量处理失败：原因写进原位文案位，不再只活在 Toast 里", () => {
  const panel = readFileSync(
    new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(panel, /toast\(describeError\(cause, "无法处理所选任务。"\), "danger"\);/);
  assert.match(panel, /setManageFeedbackReason\(describeError\(cause, "无法处理所选任务。"\)\);/);
  // 原位槽位是工具条左侧的文案位（.sidebar-manage-count: flex:1 / min-width:0，会换行），
  // 按钮位是 30px 高的 pill，塞整句会被裁掉，所以原因不并进按钮。
  assert.match(panel, /<span className="sidebar-manage-count" role=\{manageFeedbackReason \? "alert" : undefined\}>/);
  assert.match(panel, /\{manageFeedbackReason \|\| \(selectedCount > 0 \? `已选择 \$\{selectedCount\} 项` : "点选任务或终端"\)\}/);
  // 下一次尝试与退出选择模式都会清掉原因；dwell 定时器只收回确认行，不清原因（1.5s 读不完一句）。
  assert.match(panel, /setManageFeedback\("pending"\);\n\s*setManageFeedbackLabel\(""\);\n\s*setManageFeedbackReason\(""\);/);
  assert.match(panel, /setManageFeedback\("idle"\);\n\s*setManageFeedbackLabel\(""\);\n\s*setManageFeedbackReason\(""\);\n\s*\}, \[clearManageFeedbackTimer\]\)/);
  assert.match(panel, /setConfirmingManage\(false\);\n\s*setManageFeedback\("idle"\);\n\s*setManageFeedbackLabel\(""\);\n\s*\}, MOTION_DWELL_FAILED_MS\);/);
});

test("工作区与最近会话互斥展示，不重复堆叠同一批会话", () => {
  const panel = readFileSync(
    new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url),
    "utf8",
  );
  // 归属分组只有一个真源（sidebar-recent.ts），面板只做过滤与转发。
  assert.match(panel, /collectRecentEntries\(sourceGroups\)/);
  assert.match(panel, /<SidebarRecentSection\b[\s\S]*?entries=\{visibleRecentEntries\}/);
  assert.match(panel, /filterRecentEntries\(recentEntries, \{[\s\S]*?activeOnly: displayMode === "active",/);
  // 同一列表位置切换组织方式；按目录为默认，不把折叠行为冒充数据筛选。
  assert.match(panel, /ariaLabel="会话组织方式"/);
  assert.match(panel, /hidden=\{manageMode \|\| view !== "recent"\}/);
  assert.match(panel, /hidden=\{directoryId === undefined && !manageMode && view !== "directory"\}/);
  assert.match(panel, /aria-label="只看活动会话"/);
  // 重复的入口不再各自渲染一份。
  assert.doesNotMatch(panel, /sidebar-activity-rail/);
  assert.doesNotMatch(panel, /label="硅基员工"/);
  assert.doesNotMatch(panel, /label="CLI 对话"/);
});

test("最近对话：头像与「+」都在一级行，二级行只说工具", () => {
  const section = readFileSync(
    new URL("../src/web-ui/react/workspaces/sidebar-recent-section.tsx", import.meta.url),
    "utf8",
  );
  // 一级行承载身份（员工头像/群聊猫/终端标记）与快捷新增。
  assert.match(section, /avatarNode=\{<GroupMark group=\{group\} employees=\{employees\}\/>\}/);
  assert.match(section, /action=\{<GroupCreateButton group=\{group\} onStartConversation=\{onStartConversation\}\/>\}/);
  // 二级会话行只标工具，不再重复员工头像。
  assert.match(section, /avatarNode=\{<SecondaryRowMark entry=\{entry\} group=\{group\}\/>\}/);
  assert.match(section, /function SecondaryRowMark\(\{[\s\S]*?SessionProviderMark session=\{session\}/);
  assert.doesNotMatch(section, /<EmployeeAvatar[\s\S]{0,120}entry\.session/);
  // 空白终端「+」直接带上形态，员工「+」带上员工 id。
  assert.match(section, /newSessionController\.open\(\{ initialKind: "shell" \}\)/);
  assert.match(section, /newSessionController\.open\(employeeId \? \{ initialEmployeeId: employeeId \} : \{\}\)/);
  assert.match(section, /onClick=\{\(\) => onStartConversation\(group\.employeeId \?\? undefined\)\}/);
  // 侧栏一键新建员工对话：段头「+」原位展开联系人列表。
  assert.match(section, /className=\{classNames\("sidebar-section-add"/);
  assert.match(section, /<SidebarDisclosure id=\{pickerId\} open=\{pickerOpen\}>/);
});
