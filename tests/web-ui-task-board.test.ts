import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createDefaultIssueAgent,
  EMPTY_ISSUE_FILTERS,
  filterIssues,
  groupIssuesByStatus,
  ISSUE_AGENT_PROVIDERS,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  ISSUE_NO_WORKSPACE,
  isDispatchableIssueAgent,
  issueAgentModelOptions,
  normalizeIssueAgentDefaults,
  resolveIssueAgent,
  issueBoardStats,
  issueWorkspaceIdFromSelect,
  issueWorkspaceOptions,
  issueWorkspaceSelectValue,
  normalizeIssueModelCatalog,
  reorderIssues,
  sortIssues,
  withIssueAgentProvider,
  groupIssueSessionsByAgent,
  listIssueAgents,
} from "../src/web-ui/react/issues/task-board-agent.ts";
import {
  isTaskBoardView,
  TASK_BOARD_VIEW,
  TASK_BOARD_VIEW_PARAM,
  taskBoardSearch,
} from "../src/web-ui/react/issues/task-board-controller.ts";

test("issue model catalog normalizes every provider and keeps a default option", () => {
  const catalog = normalizeIssueModelCatalog({
    models: [{ id: "opus", label: "Opus" }, { id: "default", label: "默认" }],
    codexModels: [{ id: "gpt-5", label: "GPT-5" }],
    grokModels: [],
    defaultModels: { codex: "gpt-5-codex", grok: "grok-4" },
    refreshedAt: "2026-09-11T00:00:00.000Z",
  });

  // 已有 default 时不重复补，避免出现两个「默认」。
  assert.deepEqual(catalog.byProvider.claude.map((option) => option.value), ["opus", "default"]);
  // 没有 default 时补一项，并带上服务端默认模型名，避免空下拉卡住派发。
  assert.deepEqual(catalog.byProvider.codex.map((option) => option.value), ["default", "gpt-5"]);
  assert.match(catalog.byProvider.codex[0]!.label, /gpt-5-codex/);
  // 完全没有模型的 provider 也至少有一个可提交项。
  assert.deepEqual(catalog.byProvider.grok.map((option) => option.value), ["default"]);
  assert.deepEqual(catalog.byProvider.pi.map((option) => option.value), ["default"]);
  assert.equal(catalog.refreshedAt, "2026-09-11T00:00:00.000Z");
});

test("issue model options fall back when the catalog has not loaded yet", () => {
  assert.deepEqual(issueAgentModelOptions(null, "claude").map((option) => option.value), ["default"]);
  const empty = normalizeIssueModelCatalog({});
  assert.deepEqual(issueAgentModelOptions(empty, "qoder").map((option) => option.value), ["default"]);
});

test("switching provider drops models that do not exist in the new catalog", () => {
  const catalog = normalizeIssueModelCatalog({
    models: [{ id: "opus" }],
    codexModels: [{ id: "gpt-5" }],
  });
  const start = { provider: "claude" as const, model: "opus", thinkingEffort: "deep" as const };

  // 停留在同一 provider 时保留已选模型，不重置用户输入。
  assert.deepEqual(withIssueAgentProvider(start, "claude", catalog), start);
  // 换 provider 且目录里没有该模型时回退到目录首项。
  const codex = withIssueAgentProvider(start, "codex", catalog);
  assert.equal(codex.provider, "codex");
  assert.ok(issueAgentModelOptions(catalog, "codex").some((option) => option.value === codex.model));
  assert.equal(codex.thinkingEffort, "deep");
  // 目录尚未加载时仍回退到 default，绝不把旧 provider 的模型 ID 带过去。
  assert.equal(withIssueAgentProvider(start, "grok", null).model, "default");
});

test("dispatch guard only accepts supported providers with a model and effort", () => {
  assert.equal(isDispatchableIssueAgent(null), false);
  assert.equal(isDispatchableIssueAgent(createDefaultIssueAgent()), true);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "", thinkingEffort: "off" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "   ", thinkingEffort: "off" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "cursor", model: "x", thinkingEffort: "off" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "x", thinkingEffort: "insane" as never }), false);
});

test("unassigned issues reuse the last selected agent defaults", () => {
  const last = { provider: "pi" as const, model: "gpt-5", thinkingEffort: "deep" as const };
  const assigned = { provider: "codex" as const, model: "gpt-5.1", thinkingEffort: "max" as const };

  // 任务自己有配置时，不能被面板上次选择覆盖。
  assert.deepEqual(resolveIssueAgent(assigned, last), assigned);
  // 未指派时沿用上次的工具 / 模型 / 思考深度。
  assert.deepEqual(resolveIssueAgent(null, last), last);
  assert.deepEqual(resolveIssueAgent(undefined, last), last);
  // 从未保存过时仍是 Claude 默认，避免空下拉。
  assert.deepEqual(resolveIssueAgent(null), createDefaultIssueAgent());
  assert.deepEqual(normalizeIssueAgentDefaults(last), last);
  assert.deepEqual(normalizeIssueAgentDefaults({ provider: "cursor", model: "x", thinkingEffort: "off" }), createDefaultIssueAgent());
});

test("issue helpers expose columns, grouping, sorting, and workspace options", () => {
  const tasks = [
    { id: "b", status: "doing" as const, sortOrder: 1, updatedAt: "2026-01-02" },
    { id: "a", status: "todo" as const, sortOrder: 0, updatedAt: "2026-01-01" },
    { id: "c", status: "doing" as const, sortOrder: 0, updatedAt: "2026-01-01" },
  ];
  // sortOrder 优先；0 的两条同 updatedAt 时用 id 兜底，最后才是 sortOrder=1 的 b。
  assert.deepEqual(sortIssues(tasks).map((task) => task.id), ["a", "c", "b"]);
  const grouped = groupIssuesByStatus(tasks);
  assert.deepEqual(grouped.todo.map((task) => task.id), ["a"]);
  assert.deepEqual(grouped.doing.map((task) => task.id), ["b", "c"]);
  assert.deepEqual(grouped.done, []);

  const options = issueWorkspaceOptions([{ id: "w1", name: "wand", cwd: "/tmp/wand" }]);
  // Radix Select 不接受空串 option，所以「不指定项目」使用哨兵值表达。
  assert.equal(options[0]!.value, ISSUE_NO_WORKSPACE);
  assert.notEqual(options[0]!.value, "");
  assert.match(options[1]!.label, /wand/);
  assert.match(options[1]!.label, /\/tmp\/wand/);
  assert.equal(ISSUE_AGENT_PROVIDERS.length, 6);

  // 哨兵值 ↔ workspaceId 的双向转换：null / 空串 / 真实 id 都要还原正确。
  assert.equal(issueWorkspaceSelectValue(null), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue(""), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue("  "), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue("w1"), "w1");
  assert.equal(issueWorkspaceIdFromSelect(ISSUE_NO_WORKSPACE), null);
  assert.equal(issueWorkspaceIdFromSelect("w1"), "w1");
});

test("native board host talks to the Wand task API instead of the removed taskboard bridge", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /taskBoardRepository\.dispatch\(/);
  assert.match(host, /taskBoardRepository\.workspaces\(/);
  assert.match(host, /taskBoardRepository\.agentDefaults\(/);
  assert.match(host, /saveAgentDefaults\(/);
  assert.match(host, /WandSelect/);
  assert.match(host, /issueWorkspaceOptions/);
  assert.doesNotMatch(host, /iframe/);
  // React 事件对象在 updater 执行前已释放 currentTarget，必须先同步取值。
  assert.doesNotMatch(host, /setDraft\(\(current\) => \(\{ \.\.\.current, title: event\.currentTarget\.value \}\)\)/);
  assert.match(host, /const value = event\.currentTarget\.value;/);
  assert.doesNotMatch(host, /\/taskboard\//);
  assert.doesNotMatch(host, /wand-taskboard-ready/);
});

test("create form can assign the first agent from the description", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const composer = host.slice(host.indexOf("task-board-native-composer"), host.indexOf("task-board-create-footer"));
  const editor = host.slice(host.indexOf("task-board-native-assign"));

  assert.match(composer, /任务标题/);
  assert.match(composer, /可选/);
  assert.match(composer, /按描述自动生成/);
  assert.match(host, /指定项目目录/);
  assert.match(composer, /第一次指派的 CLI 工具/);
  assert.match(composer, /第一次指派的思考深度/);
  assert.match(host, /作为第一个 Agent 的指派内容/);
  assert.match(host, /submitDescription && isDispatchableIssueAgent\(draft\.agent\)/);
  assert.match(host, /taskBoardRepository\.dispatch\(created\.id, draft\.agent/);
  assert.match(host, /创建并指派/);

  assert.match(editor, /指派 Agent/);
  assert.match(editor, /先输入提示词，再选参数直接派发/);
  assert.match(editor, /任务 CLI 工具/);
  assert.match(editor, /任务模型/);
  assert.match(editor, /任务思考深度/);
  assert.match(host, /task-board-agent-add/);
  assert.match(host, /TaskBoardAgentSessionList/);
  assert.match(host, /TaskBoardAgentChips/);

  assert.match(host, /!draft\.title\.trim\(\) && !draft\.description\.trim\(\)/);
  assert.match(host, /created\.titleSource === "auto"/);
  assert.match(host, /taskBoardRepository\.get\(taskId\)/);
});

test("board host mirrors dashi layout: header tabs, column create, drag, and detail", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /task-board-workspace-header/);
  assert.match(host, /ISSUE_BOARD_VIEWS/);
  assert.match(host, /view === "dashboard"/);
  assert.match(host, /view === "list"/);
  assert.match(host, /view === "gantt"/);
  assert.match(host, /TaskBoardFilterMenu/);
  assert.match(host, /在\$\{column.label\}中新建任务/);
  assert.match(host, /application\/x-wand-task/);
  assert.match(host, /dropIndexFromPoint/);
  assert.match(host, /返回任务管理/);
  assert.match(host, /新建任务/);
  assert.match(host, /创建更多/);
  assert.deepEqual(ISSUE_BOARD_VIEWS.map((entry) => entry.value), ["dashboard", "board", "list", "gantt"]);
  assert.deepEqual(ISSUE_COLUMNS.map((column) => column.status), ["todo", "doing", "done"]);
});

test("create dialog keeps modal positioning so title and selects stay visible", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  const portal = readFileSync(new URL("../src/web-ui/react/ui/portal-context.tsx", import.meta.url), "utf8");
  const overlayRoot = readFileSync(new URL("../src/web-ui/react/index.tsx", import.meta.url), "utf8");

  // WandDialogSurface 会替换默认 class，必须自己带上定位 class，并在 CSS 里写完整的 fixed 居中。
  assert.match(host, /wand-ui-dialog-content/);
  assert.match(host, /wand-ui-dialog-overlay/);
  assert.match(styles, /\.task-board-create-overlay[^{]*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.task-board-create-dialog[^{]*\{[^}]*position:\s*fixed/s);
  assert.match(styles, /\.task-board-create-dialog[^{]*\{[^}]*transform:\s*translate\(-50%, -50%\)/s);
  assert.match(styles, /\.task-board-create-title-input,[\s\S]*color:\s*var\(--text-primary\)/);
  // 可选标题不做成第二个大标题：字号要明显小于原先 18px 的样式。
  const titleInputRule = /\.task-board-create-title-input \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(titleInputRule, /font-size:\s*(?:1[0-6]|\d)px/);
  assert.match(styles, /\.task-board-create-title-label \{[^}]*font-size:\s*var\(--font-size-xs\)/s);

  // 看板在 Shell 里，不在 OverlayHost 的 PortalProvider 下；下拉/弹层要回落到同一 portals 根。
  assert.match(portal, /document\.getElementById\(REACT_UI_PORTALS_ID\)/);
  assert.match(overlayRoot, /REACT_UI_PORTALS_ID/);
});

test("filter and reorder helpers keep board columns compact", () => {
  const tasks = [
    { id: "a", title: "登录", identifier: "TASK-1", description: "", labels: [], workspaceId: "w1", status: "todo" as const, sortOrder: 0, updatedAt: "1" },
    { id: "b", title: "支付", identifier: "TASK-2", description: "alipay", labels: ["钱"], workspaceId: "w2", status: "todo" as const, sortOrder: 1, updatedAt: "2" },
    { id: "c", title: "发货", identifier: "TASK-3", description: "", labels: [], workspaceId: "w1", status: "doing" as const, sortOrder: 0, updatedAt: "3" },
  ];
  assert.deepEqual(filterIssues(tasks, "支付", "").map((task) => task.id), ["b"]);
  assert.deepEqual(filterIssues(tasks, "", "w1").map((task) => task.id), ["a", "c"]);
  const moved = reorderIssues(tasks, "a", "doing", 0);
  assert.deepEqual(moved.filter((entry) => entry.status === "doing").map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(moved.find((entry) => entry.id === "b"), { id: "b", status: "todo", sortOrder: 0 });
  assert.deepEqual(
    filterIssues(tasks, "", "", { ...EMPTY_ISSUE_FILTERS, statuses: ["doing"] }).map((task) => task.id),
    ["c"],
  );
  assert.equal(issueBoardStats([
    { status: "todo" as const, priority: "high" as const, dueDate: "2000-01-01" },
    { status: "doing" as const, priority: "none" as const, dueDate: null },
    { status: "done" as const, priority: "low" as const, dueDate: null },
  ]).remaining, 2);
});

test("task board is a first-class view=taskboard route that does not unmount the shell", () => {
  assert.equal(TASK_BOARD_VIEW_PARAM, "view");
  assert.equal(TASK_BOARD_VIEW, "taskboard");
  assert.equal(isTaskBoardView(""), false);
  assert.equal(isTaskBoardView("?reactUi=1"), false);
  assert.equal(isTaskBoardView("?view=taskboard"), true);
  assert.equal(isTaskBoardView("view=taskboard"), true);
  assert.equal(isTaskBoardView("?reactUi=1&view=taskboard"), true);
  assert.equal(isTaskBoardView("?view=issues"), true);
  assert.equal(taskBoardSearch("", true), "?view=taskboard");
  assert.equal(taskBoardSearch("?view=taskboard", false), "");
  assert.equal(taskBoardSearch("?reactUi=1", true), "?reactUi=1&view=taskboard");
  assert.equal(taskBoardSearch("?view=taskboard&reactUi=1", false), "?reactUi=1");

  const controller = readFileSync(new URL("../src/web-ui/react/issues/task-board-controller.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/web-ui/react/shell/shell-main-content.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../src/web-ui/react/shell/shell-sidebar.tsx", import.meta.url), "utf8");

  // 打开看板必须写入独立路由，关闭走 history.back / 去掉 view=，浏览器后退才能离开。
  assert.match(controller, /history\.pushState/);
  assert.match(controller, /history\.back\(\)/);
  assert.match(controller, /addEventListener\("popstate"/);
  assert.match(controller, /installTaskBoardHistory/);

  // 主区把看板叠在会话槽位上，禁止 early-return 整块替换 <main>（那会拆掉 LegacyHost）。
  assert.match(main, /id="output"/);
  assert.match(main, /taskBoard\.open \? <TaskBoardHost/);
  assert.doesNotMatch(main, /if \(taskBoard\.open\) \{\s*return <main/s);
  assert.match(main, /onBack=\{\(\) => taskBoardController\.close\(\)\}/);

  // 看板必须绝对定位盖住主区；否则 flex 会把会话输入栏顶到议题页最上头。
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.task-board-main-content > \.task-board-native-page \{[\s\S]*position: absolute/s);
  assert.match(styles, /\.task-board-main-content > \.input-panel/);
  assert.match(styles, /\.task-board-main-content > #output/);

  // 侧栏点任务 / 首页必须离开看板，任务管理按钮本身是当前页。
  assert.match(sidebar, /leaveBoard/);
  assert.match(sidebar, /taskBoardController\.close\(\)/);
  assert.match(sidebar, /aria-current=\{taskBoard\.open \? "page" : undefined\}/);
  assert.match(host, /chevronLeft[^\n]*>返回/);
  assert.doesNotMatch(host, /返回会话/);
});

test("task detail groups sessions by the agents that actually ran", () => {
  const claude = { provider: "claude" as const, model: "opus", thinkingEffort: "deep" as const };
  const groups = groupIssueSessionsByAgent([
    { id: "s1", provider: "claude", title: "修登录", status: "running", model: "opus", thinkingEffort: "deep" },
    { id: "s2", provider: "claude", title: "补测试", status: "exited", model: "sonnet", thinkingEffort: "off" },
    { id: "s3", provider: "codex", title: "实现 API", status: "idle", model: "gpt-5", thinkingEffort: "standard" },
  ], claude);
  assert.deepEqual(groups.map((group) => group.provider), ["claude", "codex"]);
  assert.deepEqual(groups[0]!.sessions.map((session) => session.id), ["s1", "s2"]);
  assert.deepEqual(groups[1]!.sessions.map((session) => session.id), ["s3"]);
  assert.deepEqual(listIssueAgents(groups.flatMap((group) => group.sessions), claude).map((agent) => agent.provider), ["claude", "codex"]);

  const pending = groupIssueSessionsByAgent([], { provider: "pi", model: "default", thinkingEffort: "off" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.provider, "pi");
  assert.equal(pending[0]!.sessions.length, 0);
});
