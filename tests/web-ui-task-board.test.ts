import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TaskBoardAgentSessionList, TaskBoardArchiveFolder, TaskBoardListView } from "../src/web-ui/react/issues/task-board-views.js";
import type { IssueSessionSummary } from "../src/web-ui/react/issues/task-board-repository.js";

import {
  createDefaultIssueAgent,
  EMPTY_ISSUE_FILTERS,
  filterIssues,
  groupIssuesByStatus,
  ISSUE_AGENT_MODES,
  ISSUE_AGENT_PROVIDERS,
  ISSUE_ARCHIVE_COLUMN,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  ISSUE_NO_PARENT,
  ISSUE_NO_WORKSPACE,
  ISSUE_STATUS_FILTERS,
  issueArchiveFolderOpen,
  isDispatchableIssueAgent,
  issueAgentModeLabel,
  issueAgentModeOptions,
  issueAgentModelOptions,
  issueCreateDispatches,
  issueDropDispatches,
  issueDropDispatchPrompt,
  issueHideStatusFilterLabel,
  issueParentOptions,
  normalizeIssueAgentDefaults,
  resolveIssueAgent,
  issueBoardStats,
  issueProgressSeries,
  issueWorkspaceIdFromSelect,
  issueWorkspaceOptions,
  issueStatusLabel,
  issueWorkspaceSelectValue,
  normalizeIssueModelCatalog,
  withIssueAgentProvider,
  groupIssueSessionsByAgent,
  issueAgentLabel,
  listIssueAgents,
} from "../src/web-ui/react/issues/task-board-agent.ts";
import {
  isTaskBoardView,
  TASK_BOARD_VIEW,
  TASK_BOARD_VIEW_PARAM,
  taskBoardSearch,
} from "../src/web-ui/react/issues/task-board-controller.ts";
import { parseTaskBoardViewState, sortTaskBoardTasks } from "../src/web-ui/react/issues/task-board-view-state.ts";
import { sidebarActionLeavesPage } from "../src/web-ui/react/shell/shell-sidebar.tsx";

test("board browsing state restores valid filters and rejects stale or malformed values", () => {
  const restored = parseTaskBoardViewState({
    view: "list", query: "工作目录", workspaceId: "workspace-a",
    filters: { statuses: ["doing", "invalid"], priorities: ["high", null], labels: ["UI", 1] },
  });
  assert.equal(restored.view, "list");
  assert.equal(restored.query, "工作目录");
  assert.equal(restored.workspaceId, "workspace-a");
  assert.deepEqual(restored.filters, { statuses: ["doing"], priorities: ["high"], labels: ["UI"] });
  assert.equal(parseTaskBoardViewState({ view: "removed-view" }).view, "board");
  assert.deepEqual(parseTaskBoardViewState(null).filters, EMPTY_ISSUE_FILTERS);
  assert.equal(parseTaskBoardViewState({ sort: "due" }).sort, "due");
  assert.equal(parseTaskBoardViewState({ sort: "unknown" }).sort, "manual");
});

test("board sorting keeps stable ties, undated tasks last and source order intact", () => {
  const tasks = [
    { id: "a", priority: "low" as const, dueDate: null, updatedAt: "2026-10-09" },
    { id: "b", priority: "urgent" as const, dueDate: "2026-10-11", updatedAt: "2026-10-07" },
    { id: "c", priority: "urgent" as const, dueDate: "2026-10-10", updatedAt: "2026-10-08" },
  ];
  assert.equal(sortTaskBoardTasks(tasks, "manual"), tasks);
  assert.deepEqual(sortTaskBoardTasks(tasks, "priority").map((task) => task.id), ["b", "c", "a"]);
  assert.deepEqual(sortTaskBoardTasks(tasks, "due").map((task) => task.id), ["c", "b", "a"]);
  assert.deepEqual(sortTaskBoardTasks(tasks, "updated").map((task) => task.id), ["a", "c", "b"]);
  assert.deepEqual(tasks.map((task) => task.id), ["a", "b", "c"]);
});

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
  const start = { provider: "claude" as const, model: "opus", thinkingEffort: "deep" as const, mode: "managed" as const };

  // 停留在同一 provider 时保留已选模型，不重置用户输入。
  assert.deepEqual(withIssueAgentProvider(start, "claude", catalog), start);
  // 换 provider 且目录里没有该模型时回退到目录首项。
  const codex = withIssueAgentProvider(start, "codex", catalog);
  assert.equal(codex.provider, "codex");
  assert.ok(issueAgentModelOptions(catalog, "codex").some((option) => option.value === codex.model));
  assert.equal(codex.thinkingEffort, "deep");
  // Codex 只支持 full-access：换 provider 时工作模式要被夹到合法值。
  assert.equal(codex.mode, "full-access");
  // 目录尚未加载时仍回退到 default，绝不把旧 provider 的模型 ID 带过去。
  assert.equal(withIssueAgentProvider(start, "grok", null).model, "default");
});

test("dispatch guard only accepts supported providers with a model, effort, and mode", () => {
  assert.equal(isDispatchableIssueAgent(null), false);
  assert.equal(isDispatchableIssueAgent(createDefaultIssueAgent()), true);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "", thinkingEffort: "off", mode: "default" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "   ", thinkingEffort: "off", mode: "default" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "cursor", model: "x", thinkingEffort: "off", mode: "default" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "x", thinkingEffort: "insane" as never, mode: "default" }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "x", thinkingEffort: "off", mode: "yolo" as never }), false);
  assert.equal(isDispatchableIssueAgent({ provider: "claude", model: "x", thinkingEffort: "off", mode: undefined as never }), false);
});

test("work mode options cover managed, full-access, and standard", () => {
  assert.deepEqual(ISSUE_AGENT_MODES.map((entry) => entry.value), ["managed", "full-access", "default"]);
  assert.deepEqual(ISSUE_AGENT_MODES.map((entry) => entry.label), ["托管", "全限", "标准"]);
  assert.equal(issueAgentModeLabel("managed"), "托管");
  assert.equal(issueAgentModeLabel("full-access"), "全限");
  assert.equal(issueAgentModeLabel("default"), "标准");
  // 旧任务 / 未知值回落到标准，不显示空标签。
  assert.equal(issueAgentModeLabel(undefined), "标准");
  assert.equal(issueAgentModeLabel("whatever"), "标准");
  assert.equal(createDefaultIssueAgent().mode, "default");
  // Codex 只有 full-access 一个有效值（与新建会话一致）。
  assert.deepEqual(issueAgentModeOptions("claude").map((option) => option.value), ["managed", "full-access", "default"]);
  assert.deepEqual(issueAgentModeOptions("codex").map((option) => option.value), ["full-access"]);
  assert.deepEqual(issueAgentModeOptions("qoder").map((option) => option.value), ["managed", "full-access", "default"]);
  assert.equal(createDefaultIssueAgent("codex").mode, "full-access");
});

test("unassigned issues reuse the last selected agent defaults", () => {
  const last = { provider: "pi" as const, model: "gpt-5", thinkingEffort: "deep" as const, mode: "full-access" as const, kind: "pty" as const };
  const assigned = { provider: "claude" as const, model: "gpt-5.1", thinkingEffort: "max" as const, mode: "managed" as const, kind: "structured" as const };

  // 任务自己有配置时，不能被面板上次选择覆盖。
  assert.deepEqual(resolveIssueAgent(assigned, last), assigned);
  // Codex 只支持 full-access：读回旧值时也要夹到合法值。
  assert.deepEqual(
    resolveIssueAgent({ provider: "codex", model: "gpt-5", thinkingEffort: "max", mode: "managed", kind: "pty" }, last),
    { provider: "codex", model: "gpt-5", thinkingEffort: "max", mode: "full-access", kind: "pty" },
  );
  // 未指派时沿用上次的工具 / 模型 / 思考深度 / 工作模式。
  assert.deepEqual(resolveIssueAgent(null, last), last);
  assert.deepEqual(resolveIssueAgent(undefined, last), last);
  // 从未保存过时仍是 Claude 默认，避免空下拉。
  assert.deepEqual(resolveIssueAgent(null), createDefaultIssueAgent());
  assert.deepEqual(normalizeIssueAgentDefaults(last), last);
  assert.deepEqual(normalizeIssueAgentDefaults({ provider: "cursor", model: "x", thinkingEffort: "off", mode: "default" }), createDefaultIssueAgent());
});

test("issue helpers expose columns, grouping, sorting, and workspace options", () => {
  const tasks = [
    { id: "b", status: "doing" as const, createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "a", status: "todo" as const, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "c", status: "doing" as const, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  // 分组保持输入顺序（即服务端 GET /api/wand-tasks 的顺序），客户端不再二次排序。
  const grouped = groupIssuesByStatus(tasks);
  assert.deepEqual(grouped.todo.map((task) => task.id), ["a"]);
  assert.deepEqual(grouped.doing.map((task) => task.id), ["b", "c"]);
  assert.deepEqual(grouped.done, []);
  assert.deepEqual(grouped.archived, []);

  const options = issueWorkspaceOptions([{ id: "w1", name: "wand", cwd: "/tmp/wand" }]);
  // Radix Select 不接受空串 option，所以「不指定项目」使用哨兵值表达。
  assert.equal(options[0]!.value, ISSUE_NO_WORKSPACE);
  assert.notEqual(options[0]!.value, "");
  assert.match(options[1]!.label, /wand/);
  assert.match(options[1]!.label, /\/tmp\/wand/);
  assert.equal(ISSUE_AGENT_PROVIDERS.length, 7);

  // 哨兵值 ↔ workspaceId 的双向转换：null / 空串 / 真实 id 都要还原正确。
  assert.equal(issueWorkspaceSelectValue(null), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue(""), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue("  "), ISSUE_NO_WORKSPACE);
  assert.equal(issueWorkspaceSelectValue("w1"), "w1");
  assert.equal(issueWorkspaceIdFromSelect(ISSUE_NO_WORKSPACE), null);
  assert.equal(issueWorkspaceIdFromSelect("w1"), "w1");
});

test("parent task picker offers only active tasks in the same project and avoids cycles", () => {
  const tasks = [
    { id: "root", identifier: "TASK-1", title: "父任务", status: "doing" as const, workspaceId: "w1", parentTaskId: null },
    { id: "child", identifier: "TASK-2", title: "子任务", status: "doing" as const, workspaceId: "w1", parentTaskId: "root" },
    { id: "grandchild", identifier: "TASK-3", title: "孙任务", status: "doing" as const, workspaceId: "w1", parentTaskId: "child" },
    { id: "done", identifier: "TASK-4", title: "已结束", status: "done" as const, workspaceId: "w1", parentTaskId: null },
    { id: "other", identifier: "TASK-5", title: "其他项目", status: "doing" as const, workspaceId: "w2", parentTaskId: null },
  ];
  const options = issueParentOptions(tasks, "w1", "root");
  assert.deepEqual(options.map((option) => option.value), [ISSUE_NO_PARENT]);
  assert.deepEqual(issueParentOptions(tasks, "w1", "child").map((option) => option.value), [ISSUE_NO_PARENT, "root"]);
  const remembered = issueParentOptions(tasks, "w1", "grandchild", "done");
  assert.deepEqual(remembered.map((option) => option.value), [ISSUE_NO_PARENT, "root", "child", "done"]);
  assert.match(remembered.at(-1)!.label, /已结束/);
  assert.match(issueParentOptions(tasks, "w2")[1]!.label, /TASK-5 · 其他项目/);
  assert.deepEqual(issueParentOptions(tasks, undefined).map((option) => option.value),
    [ISSUE_NO_PARENT, "root", "child", "grandchild", "other"]);
});

test("native board host talks to the Wand task API instead of the removed taskboard bridge", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /taskBoardRepository\.dispatch\(/);
  assert.match(host, /taskBoardRepository\.workspaces\(/);
  // 会话模式里新建目录会在服务端生成 workspace；看板打开时必须持续拉取，
  // 否则「新建任务」的项目目录下拉停留在旧数据。
  assert.match(host, /window\.setInterval\(\(\) => \{ void loadWorkspaces\(\); void reload\(true\); \}, createOpen \? 2_000 : 6_000\)/);
  assert.match(host, /subscribeTaskChanges/);
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

test("only the doing column creates and assigns in one step", () => {
  // 「处理中」列的新建代表已经决定要跑，所以创建后立刻派发。
  assert.equal(issueCreateDispatches("doing"), true);
  // 「等待认领」只创建；「等你确认」/归档列也不应该拉起 Agent。
  assert.equal(issueCreateDispatches("todo"), false);
  assert.equal(issueCreateDispatches("done"), false);
  assert.equal(issueCreateDispatches("archived"), false);

  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  // 创建链路和新建对话框共用同一个判定，避免「按钮写创建并指派但没派发」这类不一致。
  assert.match(host, /issueCreateDispatches\(draft\.status\) && submitDescription && \(employee \|\| isDispatchableIssueAgent\(draft\.agent\)\)/);
  assert.match(host, /const createDispatches = issueCreateDispatches\(draft\.status\)/);
  // 运行模式始终可选：即使只创建任务，也要把工作模式写进全局默认。
  assert.match(host, /<Card size="small" className="task-board-create-assign" aria-label=\{createDispatches \? "第一次指派" : "Agent 与运行模式"\}>/);
  // 只创建时不出现「创建并指派」的按钮文案。
  assert.match(host, /createDispatches && draft\.description\.trim\(\) \? "创建并指派" : "创建任务"/);
  assert.match(host, /只创建任务，不指派 Agent/);
});

test("create form can assign the first agent from the description", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const composer = host.slice(host.indexOf("task-board-native-composer"), host.indexOf("task-board-create-footer"));
  const editor = host.slice(host.indexOf("task-board-native-assign"));

  assert.match(composer, /任务标题/);
  assert.match(composer, /可选/);
  assert.match(composer, /按描述自动生成/);
  assert.match(host, /指定项目目录/);
  assert.match(composer, /第一次指派给谁/);
  assert.match(composer, /第一次指派的思考深度/);
  assert.match(composer, /ariaLabel="运行模式"/);
  assert.match(composer, /issueAgentModeOptions\(draft\.agent\.provider\)/);
  assert.match(host, /作为第一个 Agent 的指派内容/);
  assert.match(host, /submitDescription && \(employee \|\| isDispatchableIssueAgent\(draft\.agent\)\)/);
  assert.match(host, /taskBoardRepository\.dispatch\(created\.id, subject\.type === "cli" \? draft\.agent : null/);
  assert.match(host, /\.\.\.\(subject\.type === "cli" \? \{ agent: draft\.agent \} : \{\}\)/);
  assert.match(host, /parentTaskId: draft\.parentTaskId \|\| null/);
  assert.match(composer, /ariaLabel="归属父任务"/);
  assert.match(host, /onCreateChild=\{\(\) => openCreate\("doing", selected\)\}/);
  assert.match(host, /aria-label="子任务"/);
  assert.match(host, /创建并指派/);

  assert.match(editor, /指派 Agent/);
  assert.match(editor, /先输入提示词，再选员工、团队或 CLI/);
  // 指派面板的执行配置控件与 AI 团队成员编辑共用 AgentFields，aria 标签按前缀拼出。
  const agentFields = readFileSync(new URL("../src/web-ui/react/issues/agent-fields.tsx", import.meta.url), "utf8");
  assert.match(editor, /<AgentFields[\s\S]*?ariaPrefix="任务"/);
  assert.match(agentFields, /\$\{ariaPrefix\}指派给/);
  assert.match(agentFields, /\$\{ariaPrefix\}模型/);
  assert.match(agentFields, /\$\{ariaPrefix\}思考深度/);
  assert.match(agentFields, /\$\{ariaPrefix\}工作模式/);
  assert.match(host, /task-board-agent-add/);
  assert.match(host, /TaskBoardAgentSessionList/);
  assert.match(host, /TaskBoardAgentChips/);

  assert.match(host, /!draft\.title\.trim\(\) && !draft\.description\.trim\(\)/);
  assert.match(host, /created\.titleSource === "auto"/);
  assert.match(host, /taskBoardRepository\.get\(taskId\)/);
});

test("board host preserves navigation, column creation, drag, and detail contracts", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /task-board-workspace-header/);
  assert.match(host, /ISSUE_BOARD_VIEWS/);
  assert.match(host, /view === "dashboard"/);
  assert.match(host, /view === "list"/);
  assert.match(host, /view === "gantt"/);
  assert.match(host, /TaskBoardFilterMenu/);
  assert.match(host, /在\$\{column.label\}中新建任务/);
  assert.match(host, /TASK_DRAG_TYPE/);
  // 列内顺序固定按创建时间；跨列拖拽换状态，拖进「处理中」时还会顺手派发首次指派。
  assert.match(host, /moving\.status === status/);
  // 返回入口一个功能只留一个：未选中任务时是「返回工作区」箭头，选中任务后交给面包屑首段「任务看板」。
  assert.match(host, /aria-label="返回工作区"/);
  assert.match(host, /\{ label: "任务看板", onNavigate: \(\) => setSelectedId\(""\) \}/);
  assert.match(host, /新建任务/);
  assert.match(host, /创建更多/);
  assert.deepEqual(ISSUE_BOARD_VIEWS.map((entry) => entry.value), ["dashboard", "board", "list", "gantt"]);
  assert.deepEqual(ISSUE_COLUMNS.map((column) => column.status), ["todo", "doing", "done"]);
  assert.equal(ISSUE_ARCHIVE_COLUMN.status, "archived");
  assert.match(host, /TaskBoardArchiveFolder/);
  assert.match(host, /issueArchiveFolderOpen/);
});

test("已完成卡片不带「完成」死按钮：写回同一个状态、触屏也看不见", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const views = readFileSync(new URL("../src/web-ui/react/issues/task-board-views.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  // done 卡片已经在 done 列，点按钮只是 patchTask(id, {status:"done"}) 写回同一个值；
  // 改状态另有拖拽与详情两处入口，这个 hover 才浮现的按钮是无语义残留。
  assert.doesNotMatch(host, /TaskBoardCompleteButton/);
  assert.doesNotMatch(views, /TaskBoardCompleteButton/);
  assert.doesNotMatch(styles, /\.task-board-card-complete\b/);
  assert.doesNotMatch(styles, /\.task-board-card\.is-done:hover \.task-board-card-complete/);
});

test("dropping an unassigned task into doing asks before sending the card description", () => {
  // 没派发过的任务拖进「处理中」可以派发，但必须先把将要发出的任务说明摆出来确认。
  assert.equal(issueDropDispatches("doing", 0), true);
  // 已经在跑 / 跑过的任务只改状态，避免拖一下就多开一个 session。
  assert.equal(issueDropDispatches("doing", 1), false);
  assert.equal(issueDropDispatches("todo", 0), false);
  assert.equal(issueDropDispatches("done", 0), false);
  assert.equal(issueDropDispatches("archived", 0), false);

  // 提示词回退顺序：描述 → 标题 → 兜底指令。
  assert.equal(issueDropDispatchPrompt({ title: "标题", description: " 描述 " }), "描述");
  assert.equal(issueDropDispatchPrompt({ title: "标题", description: "   " }), "标题");
  assert.equal(issueDropDispatchPrompt({ title: "", description: "" }), "执行此任务");

  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  assert.match(host, /const dispatches = issueDropDispatches\(status, moving\.sessions\.length\)/);
  assert.match(host, /issueDropDispatchPrompt\(moving\)/);
  assert.match(host, /用任务说明启动/);
  assert.match(host, /按这段说明派发/);
  assert.match(host, /只移入处理中/);
  assert.match(host, /taskBoardRepository\.dispatch\(taskId,[\s\S]*?moving\.executionSubject && moving\.executionSubject\.type !== "cli" \? null : agent/);
  // 派发用任务上的指派，未指派时沿用面板上次选择。
  assert.match(host, /const agent = dispatches \? agentOf\(moving, lastAgentRef\.current\) : null/);
  // 派发失败不回滚状态，只提示并保留任务在「处理中」。
  assert.match(host, /任务已移入「处理中」，但派发 Agent 失败/);
});

test("create dialog keeps modal positioning so title and selects stay visible", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  const portal = readFileSync(new URL("../src/web-ui/react/ui/portal-context.tsx", import.meta.url), "utf8");
  const overlayRoot = readFileSync(new URL("../src/web-ui/react/index.tsx", import.meta.url), "utf8");

  const layout = readFileSync(new URL("../src/web-ui/react/issues/library-layout.ts", import.meta.url), "utf8");
  assert.match(host, /wand-task-library-dialog/);
  assert.match(host, /WandDialogSurface/);
  assert.match(layout, /\.ant-modal:has\(\.wand-task-library-dialog\)/);
  assert.match(layout, /max-height:[^;]*100dvh/);
  assert.match(layout, /overflow: auto/);
  assert.match(host, /<TaskTextArea[\s\S]*?task-board-create-title-input/);

  // 看板在 Shell 里，不在 OverlayHost 的 PortalProvider 下；下拉/弹层要回落到同一 portals 根。
  assert.match(portal, /document\.getElementById\(REACT_UI_PORTALS_ID\)/);
  assert.match(overlayRoot, /REACT_UI_PORTALS_ID/);
});

test("filter helpers keep board columns compact", () => {
  const tasks = [
    { id: "a", title: "登录", identifier: "TASK-1", description: "", labels: [], workspaceId: "w1", status: "todo" as const, sortOrder: 0, updatedAt: "1" },
    { id: "b", title: "支付", identifier: "TASK-2", description: "alipay", labels: ["钱"], workspaceId: "w2", status: "todo" as const, sortOrder: 1, updatedAt: "2" },
    { id: "c", title: "发货", identifier: "TASK-3", description: "", labels: [], workspaceId: "w1", status: "doing" as const, sortOrder: 0, updatedAt: "3" },
  ];
  assert.deepEqual(filterIssues(tasks, "支付", "").map((task) => task.id), ["b"]);
  assert.deepEqual(filterIssues(tasks, "", "w1").map((task) => task.id), ["a", "c"]);
  assert.deepEqual(
    filterIssues(tasks, "", "", { ...EMPTY_ISSUE_FILTERS, statuses: ["doing"] }).map((task) => task.id),
    ["c"],
  );
  assert.equal(issueBoardStats([
    { status: "todo" as const, priority: "high" as const, dueDate: "2000-01-01" },
    { status: "doing" as const, priority: "none" as const, dueDate: null },
    { status: "done" as const, priority: "low" as const, dueDate: null },
  ]).remaining, 2);
  const withArchived = [
    ...tasks,
    { id: "d", title: "旧登录", identifier: "TASK-4", description: "", labels: [], workspaceId: "w1", status: "archived" as const, sortOrder: 0, updatedAt: "4" },
  ];
  assert.deepEqual(filterIssues(withArchived, "", "").map((task) => task.id), ["a", "b", "c"]);
  assert.deepEqual(filterIssues(withArchived, "旧登录", "").map((task) => task.id), []);
  assert.deepEqual(filterIssues(withArchived, "旧登录", "", EMPTY_ISSUE_FILTERS, true).map((task) => task.id), ["d"]);
  assert.deepEqual(
    filterIssues(withArchived, "", "", { ...EMPTY_ISSUE_FILTERS, statuses: ["archived"] }).map((task) => task.id),
    ["d"],
  );
  assert.deepEqual(groupIssuesByStatus(withArchived).archived.map((task) => task.id), ["d"]);
  assert.equal(issueArchiveFolderOpen(true, "", EMPTY_ISSUE_FILTERS), false);
  assert.equal(issueArchiveFolderOpen(true, "旧登录", EMPTY_ISSUE_FILTERS), false);
  assert.equal(issueArchiveFolderOpen(false, "", EMPTY_ISSUE_FILTERS), true);
  assert.equal(issueArchiveFolderOpen(true, "", { ...EMPTY_ISSUE_FILTERS, statuses: ["archived"] }), true);
  assert.deepEqual(ISSUE_STATUS_FILTERS.map((entry) => entry.status), ["todo", "doing", "done", "archived"]);
  assert.deepEqual(issueBoardStats([
    { status: "todo" as const, priority: "none" as const, dueDate: null },
    { status: "done" as const, priority: "low" as const, dueDate: null },
    { status: "archived" as const, priority: "urgent" as const, dueDate: "2000-01-01" },
  ]), { total: 2, todo: 1, doing: 0, done: 1, overdue: 0, high: 0, remaining: 1 });
  const progress = issueProgressSeries(withArchived.map((task) => ({ ...task, createdAt: "2000-01-01", updatedAt: "2000-01-02" })));
  assert.equal(progress.at(-1)?.scope, 3);
  assert.equal(progress.at(-1)?.completed, 0);
});

test("archive entry remains available while archived cards are hidden", () => {
  const empty = { todo: [], doing: [], done: [], archived: [] };
  const markup = renderToStaticMarkup(createElement(TaskBoardListView, {
    grouped: empty, allTasks: [], collapsed: { todo: false, doing: false, done: false, archived: true },
    archiveOpen: false, archiveCount: 3, onToggle() {}, onToggleArchive() {}, onOpen() {},
  }));
  assert.match(markup, /task-board-archive-header/);
  assert.match(markup, /aria-expanded="false"/);
  const folder = renderToStaticMarkup(createElement(TaskBoardArchiveFolder, {
    count: 3, open: false, onToggle() {}, children: createElement("div", null, "hidden archived title"),
  }));
  assert.doesNotMatch(folder, /hidden archived title/);
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

  // 路由层由组件自身覆盖主区，LegacyHost 槽位仍常驻。
  assert.match(host, /<Flex component="section"[\s\S]*?className="task-board-native-page"/);
  assert.match(readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8"), /\.task-board-native-page\s*\{[^}]*position:absolute; inset:0; z-index:8/);
  assert.match(main, /id="output"[\s\S]*?snapshot\.legacyVisibility\.terminal/);
  assert.match(main, /ref=\{legacyRefs\?\.composer\}[\s\S]*?snapshot\.legacyVisibility\.composer/);

  // 真正导航离开看板；设置 / 创建表单只暂时覆盖当前页，取消后仍返回看板。
  assert.equal(sidebarActionLeavesPage({ type: "nav.home" }), true);
  assert.equal(sidebarActionLeavesPage({ type: "session.select", id: "session-1" }), true);
  assert.equal(sidebarActionLeavesPage({ type: "settings.open" }), false);
  assert.equal(sidebarActionLeavesPage({ type: "workspace.new" }), false);
  assert.match(sidebar, /if \(sidebarActionLeavesPage\(action\)\) \{ settingsController\.close\(\); taskBoardController\.close\(\); conversationUi\.suspend\(\)/);
  assert.match(sidebar, /const navigateFromTree = \(\): void => \{\s*settingsController\.close\(\);\s*taskBoardController\.close\(\)/);
  assert.match(sidebar, /onNavigate=\{navigateFromTree\}/);
  // 功能导航既有库按钮高亮，也保留当前页语义。
  assert.match(sidebar, /activePage=\{settings\.open \? null : taskBoard\.open \? taskBoard\.page === "board" \? "board" : "teams"/);
  const navigation = readFileSync(new URL("../src/web-ui/react/conversations/sidebar.tsx", import.meta.url), "utf8");
  assert.match(navigation, /aria-current=\{activePage === entry\.value \? "page" : undefined\}/);
  // 同一功能只留一个可见入口：箭头只在未选中任务时出现（返回工作区），选中任务后返回交给面包屑首段。
  assert.match(host, /\{!selected \? <WandIconButton/);
  assert.match(host, /aria-label="返回工作区"/);
  assert.doesNotMatch(host, /返回任务看板/);
  assert.doesNotMatch(host, /返回会话/);
});

test("task detail groups sessions by the agents that actually ran", () => {
  const claude = { provider: "claude" as const, model: "opus", thinkingEffort: "deep" as const, mode: "managed" as const };
  const groups = groupIssueSessionsByAgent([
    { id: "s1", provider: "claude", title: "修登录", status: "running", model: "opus", thinkingEffort: "deep", mode: "managed" },
    { id: "s2", provider: "claude", title: "补测试", status: "exited", model: "sonnet", thinkingEffort: "off", mode: "full-access" },
    { id: "s3", provider: "codex", title: "实现 API", status: "idle", model: "gpt-5", thinkingEffort: "standard", mode: "default" },
  ], claude);
  assert.deepEqual(groups.map((group) => group.provider), ["claude", "codex"]);
  assert.deepEqual(groups[0]!.sessions.map((session) => session.id), ["s1", "s2"]);
  assert.deepEqual(groups[1]!.sessions.map((session) => session.id), ["s3"]);
  assert.deepEqual(listIssueAgents(groups.flatMap((group) => group.sessions), claude).map((agent) => agent.provider), ["claude", "codex"]);
  // 会话上的执行模式要能回读到分组里的 agent；codex 只支持 full-access。
  assert.equal(groups[1]!.agent?.mode, "full-access");

  const pending = groupIssueSessionsByAgent([], { provider: "pi", model: "default", thinkingEffort: "off", mode: "managed" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.provider, "pi");
  assert.equal(pending[0]!.sessions.length, 0);
});

test("task detail drafts survive the silent board refresh", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  // 轮询与 WS 刷新每次都给出新的 task 对象：把 labels 数组或 description 的引用变化
  // 写进依赖，「再指派一个 Agent」面板会在用户输入途中自己关掉。
  assert.doesNotMatch(host, /\[task\.id, task\.title, task\.description, task\.labels/);
  assert.match(host, /\[task\.id, task\.title, labelKey\]/);
  assert.match(host, /\[task\.id, sessionCount\]/);
});

test("done 状态只有一个界面名：列名、概览指标、过滤开关同源", () => {
  const column = ISSUE_COLUMNS.find((item) => item.status === "done")!;
  assert.equal(issueStatusLabel("done"), "等你确认");
  assert.equal(column.label, issueStatusLabel("done"), "列名就是那个唯一来源");
  assert.equal(column.empty, `还没有${issueStatusLabel("done")}的任务`, "空态文案也跟着走，不再「待确认」另起一词");
  assert.equal(issueStatusLabel("archived"), ISSUE_ARCHIVE_COLUMN.label);
  assert.equal(issueHideStatusFilterLabel("done"), "隐藏「等你确认」");

  const views = readFileSync(new URL("../src/web-ui/react/issues/task-board-views.tsx", import.meta.url), "utf8");
  // 同文件曾经三处各写一份：概览「已确认」、图例「已确认」、开关「隐藏已确认」。
  assert.doesNotMatch(views, /["」>]已确认|已确认["「<]/);
  assert.doesNotMatch(views, /隐藏已确认|等你确认|待确认/);
  assert.match(views, /\{metric\(issueStatusLabel\("done"\), stats\.done, "done"\)\}/);
  assert.match(views, /aria-label="任务状态"/);
  assert.match(views, /title="需要关注"/);
  assert.doesNotMatch(views, /task-board-progress-chart|issueProgressSeries/);
  assert.match(views, /\{issueHideStatusFilterLabel\("done"\)\}/);
  assert.match(views, /<span>\{issueStatusLabel\(task\.status\)\}<\/span>/, "行内状态标签也读同一处");
});

test("会话状态界面名只有一份映射，未知值不再一律兑成「空闲」", () => {
  const views = readFileSync(new URL("../src/web-ui/react/issues/task-board-views.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(views, /function (issueSessionStatusLabel|taskStatusLabel)\b/, "同一概念的两套映射已合并");
  assert.equal((views.match(/function sessionStatusLabel/g) ?? []).length, 1);
  assert.match(views, /if \(status === "running" \|\| status === "thinking"\) return "进行中";/);
  assert.match(views, /if \(status === "idle"\) return "空闲";/);
  assert.match(views, /return status \|\| "会话";/, "认不出来回退原值，空串才给「会话」");
  assert.doesNotMatch(views, /function sessionStatusLabel[\s\S]{0,400}return "空闲";\n\}/, "结尾不再是无兜底的「空闲」");
  assert.match(views, /sessionStatusLabel\(session\.status\)\]/);
  assert.match(views, /<small>\{sessionStatusLabel\(session\.status\)\}<\/small>/);
});

test("看板卡片点击就地展开，不再把整块看板换成详情页（动效第 7 条）", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const views = readFileSync(new URL("../src/web-ui/react/issues/task-board-views.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  const card = host.slice(host.indexOf("const renderCard"), host.indexOf("const renderColumn"));
  const detail = views.slice(
    views.indexOf("export function TaskBoardCardDetail"),
    views.indexOf("export function TaskBoardListView"),
  );

  // 触发区仍是整张卡片，但语义换成展开/收起，属性与列表行同一组。
  assert.match(card, /className=\{classNames\(\s*"task-board-card",\s*`is-\$\{task\.status\}`,\s*expanded && "is-open"/);
  assert.match(card, /aria-expanded=\{expanded\}/);
  assert.match(card, /aria-controls=\{`task-card-detail-\$\{task\.id\}`\}/);
  assert.match(card, /aria-label=\{`\$\{expanded \? "收起" : "展开"\} \$\{task\.identifier\}: \$\{task\.title\}`\}/);
  assert.match(card, /onClick=\{\(\) => setExpandedTaskId\(\(current\) => current === task\.id \? "" : task\.id\)\}/);
  assert.doesNotMatch(card, /setSelectedId\(task\.id\)/, "卡片点击不再走整板替换");

  // 展开区必须比重叠态更完整：状态 / 负责人 / 迭代 / 截止 / 会话（带状态）/ 描述全文。
  for (const label of ["状态", "负责人", "迭代", "截止", "更新", "父任务", "子任务"]) {
    assert.ok(detail.includes(`label: "${label}"`), `展开区要有「${label}」`);
  }
  assert.match(detail, /label: "状态", children: issueStatusLabel\(task\.status\)/);
  assert.match(detail, /\{description \|\| "还没有填写任务说明。"\}/, "描述全文常驻，截断版才是条件显示");
  assert.match(detail, /dataSource=\{task\.sessions\}/);
  assert.match(detail, /<Typography.Text type="secondary">\{sessionStatusLabel\(session\.status\)\}<\/Typography.Text>/);

  // 完整详情仍是既有那条路（面包屑 任务看板 › TASK-xxx 依赖 selectedId）。
  assert.match(detail, /onClick=\{\(\) => onOpen\(task\.id\)\}/);
  assert.match(detail, /查看完整详情/);
  assert.match(card, /onOpen=\{setSelectedId\}/);
  assert.match(host, /\{selected \? <IssueDetail/);

  // 关闭路径逐条：面板内收起按钮、再次点击（toggle）、Esc、切视图/搜索/筛选、进详情、重开面板、拖拽开始。
  assert.match(detail, /onCollapse\(\)/);
  assert.match(card, /onCollapse=\{\(\) => setExpandedTaskId\(""\)\}/);
  assert.match(host, /setExpandedTaskId\(""\);\s*\}, \[view, query, filterWorkspaceId, filters, selectedId, controller\.open, controller\.revision\]\);/);
  assert.match(host, /onDragStart=\{\(event\) => \{\s*if \(event\.target !== event\.currentTarget\) return;[\s\S]{0,120}setExpandedTaskId\(""\);/);
  assert.match(host, /if \(expandedTaskId\) \{\s*setExpandedTaskId\(""\);\s*return;\s*\}/);
  // Esc 一次只退一层：新建对话框 → 完整详情 → 展开的卡片 → 离开看板。
  const esc = host.slice(host.indexOf('if (event.key !== "Escape"'), host.indexOf("window.addEventListener(\"keydown\", onKey)"));
  const escOrder = ["createOpen", "selectedId", "expandedTaskId"].map((name) => esc.indexOf(`if (${name}) {`));
  assert.deepEqual(escOrder, [...escOrder].sort((a, b) => a - b), "三段都在，且按 对话框→详情→展开卡片 的次序退");
  assert.ok(escOrder.every((index) => index >= 0), "Esc 的三段退层缺一不可");
  assert.match(views, /inert=\{!open\}/, "收起后展开区不可聚焦，Tab 不会走进面板");
  assert.match(views, /id=\{`task-card-detail-\$\{task\.id\}`\}/);

  // 折叠、尺寸与动效归库组件，关闭时内容不可聚焦；不再靠全局卡片 CSS。
  assert.match(detail, /<Collapse[\s\S]*?activeKey=\{open \? \["details"\] : \[\]\}/);
  assert.match(detail, /forceRender: true/);
  assert.match(detail, /<Descriptions size="small" column=\{1\} items=\{fields\}/);
  assert.match(card, /<Card size="small"/);
  // Host spacing may style the inner content; visibility and animation stay in Ant Collapse.
  assert.doesNotMatch(styles, /\.task-board-card-detail\s*\{[^}]*\b(display|height|opacity|animation):/);
  // 完整版与简版会话保留同一份数据，展开时只显示完整版。
  assert.match(card, /className="task-board-session-list" style=\{\{ display: expanded \? "none" : undefined \}\}/);
});

test("死导出清理：TaskBoardCompleteIcon 随「完成」死按钮一起消失", () => {
  const icons = readFileSync(new URL("../src/web-ui/react/issues/task-board-icons.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(icons, /TaskBoardCompleteIcon/);
});

test("非点击收起后焦点还给触发按钮，看板与列表共用一份实现", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  const views = readFileSync(new URL("../src/web-ui/react/issues/task-board-views.tsx", import.meta.url), "utf8");
  // 实现只有一份，放在列表行同一侧，宿主 import 过来用。
  assert.equal((views.match(/function useExpansionFocusReturn/g) ?? []).length, 1);
  assert.match(host, /useExpansionFocusReturn,\n\} from "\.\/task-board-views"/);
  assert.match(host, /const bindCardTrigger = useExpansionFocusReturn\(expandedTaskId\);/);
  assert.match(host, /<WandButton kind="ghost"\s+type="button"\s+ref=\{bindCardTrigger\(task\.id\)\}\s+className="task-board-card-open"/);
  assert.match(views, /const bindTrigger = useExpansionFocusReturn\(expandedId \?\? ""\);/);
  assert.match(views, /const triggerRef = React\.useMemo\(\(\) => bindTrigger\(task\.id\), \[bindTrigger, task\.id\]\);/);
  assert.equal((views.match(/ref=\{triggerRef\}/g) ?? []).length, 1, "列表行的标题按钮就是归还目标");
  assert.match(views, /bindTrigger=\{bindTrigger\}/, "普通行与归档行都挂同一个登记器");
  // 边界：只在「由开转关」时处理，且触发元素还在文档里、焦点确实被甩掉，才动焦点。
  assert.match(views, /if \(!previous \|\| openId\) return;/);
  assert.match(views, /if \(!trigger\?\.isConnected\) return;/, "行被筛掉、视图换掉时不动焦点");
  assert.match(views, /if \(active && active !== document\.body && active !== document\.documentElement\) return;/,
    "用户已经点到别处就不抢");
});

test("拖入「处理中」的确认文案是一句连贯的话，不靠裸换行分段", () => {
  const host = readFileSync(new URL("../src/web-ui/react/issues/task-board-host.tsx", import.meta.url), "utf8");
  // ui/dialog.tsx 把 description 当单个字符串渲染成一段（没有 pre-line），\n\n 只会变成一个空格。
  assert.doesNotMatch(host, /description: `拖进「处理中」[\s\S]{0,120}?\\n\\n/);
  assert.match(host, /不是指派框里新写的提示词：「\$\{preview\}」`/);
});

test("看板行不写「默认模型」：default 哨兵渲染成服务端默认模型的名字", () => {
  // 目录桩：Claude 配了默认模型 opus（目录里那个 default 项文案里没有名字）。
  const catalog = normalizeIssueModelCatalog({
    models: [{ id: "default", label: "跟随 Claude Code 默认" }, { id: "opus", label: "opus（最新 Opus）" }],
    defaultModels: { claude: "opus" },
  });
  const session = (over: Partial<IssueSessionSummary> = {}): IssueSessionSummary => ({
    id: "s1",
    provider: "claude",
    sessionKind: "structured",
    title: "",
    status: "idle",
    cwd: "/repo",
    model: "default",
    thinkingEffort: "standard",
    ...over,
  });
  const agent = { provider: "claude" as const, model: "default", thinkingEffort: "standard", mode: "default" as const };
  const html = renderToStaticMarkup(createElement(TaskBoardAgentSessionList, {
    sessions: [session()],
    assigned: agent,
    catalog,
  }));
  assert.match(html, /Claude/);
  assert.match(html, /opus/, "组头写默认模型的名字");
  assert.doesNotMatch(html, /默认模型/, "不再有占位文案");
  // 目录里只有「跟随 Claude Code 默认」这种没名字的文案时同样不写占位，只省掉模型段。
  const anonymous = renderToStaticMarkup(createElement(TaskBoardAgentSessionList, {
    sessions: [session()],
    assigned: agent,
    catalog: normalizeIssueModelCatalog({ models: [{ id: "default", label: "跟随 Claude Code 默认" }] }),
  }));
  assert.doesNotMatch(anonymous, /默认模型|跟随 Claude Code 默认/);
  // 目录没到时只省掉模型段，不落回占位文案。
  const bare = renderToStaticMarkup(createElement(TaskBoardAgentSessionList, {
    sessions: [session()],
    assigned: agent,
    catalog: null,
  }));
  assert.doesNotMatch(bare, /默认模型/);
});

test("Pi 与 Wand Agent 在任务面板上是两个标签、两个分组", () => {
  assert.equal(issueAgentLabel("pi", "sdk"), "Wand Agent", "进程内 SDK 会话不能显示成 Pi");
  assert.equal(issueAgentLabel("pi", "cli"), "Pi");
  assert.equal(issueAgentLabel("pi"), "Pi", "拿不到引擎时仍按 Pi CLI");
  assert.equal(issueAgentLabel("claude", "sdk"), "Claude", "引擎只属于 pi，别的 provider 不受影响");

  const sessions: IssueSessionSummary[] = [
    { id: "cli-1", provider: "pi", sessionKind: "structured", title: "Pi 会话", status: "idle", cwd: "/w", model: "default", thinkingEffort: "off", engine: "cli" },
    { id: "sdk-1", provider: "pi", sessionKind: "structured", title: "Wand Agent 会话", status: "idle", cwd: "/w", model: "default", thinkingEffort: "off", engine: "sdk" },
  ];
  const groups = groupIssueSessionsByAgent(sessions);
  assert.equal(groups.length, 2, "同一个 provider 的两条执行路径不能挤成一组");
  assert.deepEqual(groups.map((group) => [group.provider, group.engine ?? "cli"]), [["pi", "cli"], ["pi", "sdk"]]);
  assert.deepEqual(groups.map((group) => group.sessions.map((session) => session.id)), [["cli-1"], ["sdk-1"]]);
  assert.equal(groups[1].agent?.engine, "sdk", "分组里的 agent 要带上引擎，派发时才知道走 SDK");

  const markup = renderToStaticMarkup(createElement(TaskBoardAgentSessionList, {
    sessions, assigned: null, catalog: null,
  }));
  assert.match(markup, /Wand Agent/, "指派记录里要能看出跑的是 Wand Agent");
});
