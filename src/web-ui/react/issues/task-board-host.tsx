import { buildTaskDispatchPrompt, taskDispatchConfiguration } from "./task-dispatch-preview";
import { TaskAcceptanceEditor } from "./task-acceptance";
import { TaskSessionSummary } from "./task-session-summary";
import { taskAcceptanceLabel } from "./task-delivery-state";
import { taskGoalProjection } from "../../../task-hierarchy";
import { TaskGoalChildren } from "./task-goal-children";
import { canArchiveBoardTask } from "./task-board-repository";
import "./library-layout";
import { TaskTextArea } from "./task-form";
import { TaskDatePicker } from "./date-picker";
import { WandInput } from "../ui";
import * as React from "react";
import { Alert, Card, Collapse, Flex, Form, Typography } from "antd";
import { subscribeWandModelCatalog } from "../model-catalog";
import { subscribeTaskChanges } from "../task-changes";
import { draggedTaskId, isTaskDrag, startTaskDrag, TASK_DRAG_TYPE } from "./task-drag";
import { draggedSessionId, isSessionDrag, startSessionDrag } from "../workspaces/session-drag";
import { SessionMoveButton } from "../workspaces/session-move-button";
import { workspacesStore } from "../workspaces/controller";
import { TaskOrganizeButton } from "../workspaces/task-organization";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { type TaskExecutionSubject, type WandTaskAgent, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import {
  WandBreadcrumb,
  WandButton,
  WandIcon,
  WandIconButton,
  WandSelect,
  WandSearchField,
  WandSkeleton,
  WandStretchTabs,
  WandSwitch,
} from "../ui";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { classNames } from "../ui/class-names";
import { MilestonePicker } from "../milestones/picker";
import {
  collectIssueLabels,
  createDefaultIssueAgent,
  DEFAULT_ISSUE_BOARD_DISPLAY,
  EMPTY_ISSUE_FILTERS,
  filterIssues,
  issueBoardEmptyState,
  groupIssuesByStatus,
  ISSUE_AGENT_TARGETS,
  ISSUE_ARCHIVE_COLUMN,
  ISSUE_NO_PARENT,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  ISSUE_PRIORITIES,
  issueArchiveFolderOpen,
  issueDropDispatches,
  issueDropDispatchPrompt,
  issueAgentLabel,
  issueDueStamp,
  issueFilterCount,
  issueIsOverdue,
  issueParentOptions,
  issueWorkspaceIdFromSelect,
  issueWorkspaceOptions,
  issueWorkspaceSelectValue,
  normalizeIssueModelCatalog,
  readIssueBoardDisplay,
  resolveIssueAgent,
  writeIssueBoardDisplay,
  type IssueAgentProvider,
  type IssueBoardDisplay,
  type IssueBoardFilters,
  type IssueBoardView,
  type IssueGanttZoom,
  type IssueModelCatalog,
} from "./task-board-agent";
import { AgentField, AgentFields } from "./agent-fields";
import { aiTeamsRepository, type AiTeam } from "../ai-teams/repository";
import { TaskTeamRunPanel } from "../ai-teams/lazy";
import { TaskComments } from "./task-comments";
import { TaskReferenceableTasks } from "./task-referenceable-tasks";
import { TaskDescription } from "./task-description";
import { taskBoardController, taskBoardStore } from "./task-board-controller";
import { taskBoardRepository, type IssueWorkspace, type WandTaskListed } from "./task-board-repository";
import { openTaskSessionCreation } from "./task-session-create";
import {
  TaskBoardAgentChips,
  TaskBoardArchiveFolder,
  TaskBoardCardDetail,
  TaskBoardContextMenu,
  TaskBoardConversationButton,
  TaskBoardCommentCountButton,
  TaskBoardDashboard,
  TaskBoardDisplayMenu,
  TaskBoardFilterMenu,
  TaskBoardGantt,
  TaskBoardLabelChip,
  TaskBoardMilestoneChip,
  TaskBoardListView,
  TaskBoardPriorityChip,
  TaskBoardProcessingRow,
  TaskBoardProjectChip,
  TaskBoardStatusGlyph,
  useExpansionFocusReturn,
} from "./task-board-views";
import { wandOverlay } from "../overlay-controller";
import { parseTaskBoardViewState, readTaskBoardViewState, writeTaskBoardViewState, sortTaskBoardTasks, TASK_BOARD_SORTS, type TaskBoardSort } from "./task-board-view-state";
import { pageSearch, updatePageRoute } from "../../page-route";
import { usePageRouteState, routeEnum, routeJson } from "../use-page-route";
import { CopyPageLink } from "../ui/copy-page-link";
import { parseIssueAssignment, readIssueAssignment, resolveIssueAssignment, writeIssueAssignment } from "./task-board-assignment";
import { newSessionController } from "../new-session/controller";

function agentOf(task: WandTaskListed, lastAgent?: WandTaskAgent | null): WandTaskAgent {
  return resolveIssueAgent(task.agent, lastAgent);
}

function columnOf(status: WandTaskStatus) {
  return ISSUE_COLUMNS.find((column) => column.status === status) ?? ISSUE_COLUMNS[0]!;
}

const IssueField = AgentField;
const taskDispatchDrafts = new Map<string, string>();

export interface TaskBoardHostProps {
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onBack?: () => void;
  readonly onOpenSidebar?: () => void;
  readonly sidebarOpen?: boolean;
}

/** Wand 原生任务管理：布局与交互对标 dashi-taskboard。 */
export function TaskBoardHost({
  onOpenSession,
  onBack,
  onOpenSidebar,
  sidebarOpen = false,
}: TaskBoardHostProps = {}): React.ReactElement | null {
  const controller = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const providerUsage = useProviderUsage(controller.open);
  const providerOptions = providerUsage === null ? null : sortProviderOptions(
    ISSUE_AGENT_TARGETS, providerUsage, (entry) => entry.provider,
  ).map((entry) => ({ value: entry.value, label: entry.label }));

  const [tasks, setTasks] = React.useState<WandTaskListed[]>([]);
  const [workspaces, setWorkspaces] = React.useState<IssueWorkspace[]>([]);
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busyId, setBusyId] = React.useState("");
  const [sessionDropTarget, setSessionDropTarget] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [query, setQuery] = usePageRouteState("q", "", undefined, undefined, "replace", 250);
  const [view, setView] = usePageRouteState<IssueBoardView>("boardView", "board", routeEnum(ISSUE_BOARD_VIEWS.map(item => item.value), "board"), String, "push");
  const [sort, setSort] = usePageRouteState<TaskBoardSort>("sort", "manual", routeEnum(TASK_BOARD_SORTS.map(item => item.value), "manual"));
  const [display, setDisplay] = React.useState<IssueBoardDisplay>(() => readIssueBoardDisplay());
  const [filters, setFilters] = usePageRouteState<IssueBoardFilters>("filters", EMPTY_ISSUE_FILTERS,
    value => parseTaskBoardViewState({ filters: JSON.parse(value) }).filters, routeJson);
  const [ganttZoom, setGanttZoom] = React.useState<IssueGanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = React.useState(false);
  const [filterWorkspaceId, setFilterWorkspaceId] = usePageRouteState("directory", "");
  // A bare board link reopens where this tab left off; an explicit link always wins.
  const skipPersist = React.useRef(false);
  React.useEffect(() => {
    const params = new URLSearchParams(pageSearch());
    if (["boardView", "sort", "filters", "q", "directory"].some(key => params.has(key))) return;
    const saved = readTaskBoardViewState();
    const patch: Record<string, string | null> = {
      boardView: saved.view === "board" ? null : saved.view, sort: saved.sort === "manual" ? null : saved.sort,
      q: saved.query || null, directory: saved.workspaceId || null,
      filters: routeJson(saved.filters) === routeJson(EMPTY_ISSUE_FILTERS) ? null : routeJson(saved.filters),
    };
    if (Object.values(patch).every(value => value === null)) return;
    skipPersist.current = true;
    updatePageRoute(patch, "replace");
  }, []);
  React.useEffect(() => {
    if (skipPersist.current) { skipPersist.current = false; return; }
    writeTaskBoardViewState({ view, query, workspaceId: filterWorkspaceId, filters, sort });
  }, [view, query, filterWorkspaceId, filters, sort]);
  const mutationPending = React.useRef(false);
  const [selectedId, setSelectedId] = usePageRouteState("task", "", undefined, undefined, "push");
  // 看板卡片的就地展开态，同一时刻只开一张；完整详情仍由 selectedId 那套详情页承担。
  const [expandedTaskId, setExpandedTaskId] = React.useState("");
  // 非点击收起（换视图、改筛选、Esc）后，把焦点还给那张卡片的触发按钮，和列表行共用一份实现。
  const bindCardTrigger = useExpansionFocusReturn(expandedTaskId);
  const [detailAgent, setDetailAgent] = React.useState<WandTaskAgent | null>(null);
  // 团队与 CLI 在同一个下拉里：选中团队时记下团队 id，派发改成交给团队。
  const [teams, setTeams] = React.useState<AiTeam[] | null>(null);
  const { employees, loading: employeesLoading, error: employeesError } = useSiliconEmployees();
  const [lastAssignment, setLastAssignment] = React.useState(readIssueAssignment);
  const lastAssignmentRef = React.useRef(lastAssignment);
  lastAssignmentRef.current = lastAssignment;
  const detailChoiceTaskRef = React.useRef("");
  const [teamTarget, setTeamTarget] = React.useState("");
  const [employeeTarget, setEmployeeTarget] = React.useState("");
  const [employeeOverride, setEmployeeOverride] = React.useState(false);
  const [teamRunRefresh, setTeamRunRefresh] = React.useState(0);
  const [lastAgent, setLastAgent] = React.useState<WandTaskAgent>(() => createDefaultIssueAgent());
  const lastAgentRef = React.useRef(lastAgent);
  lastAgentRef.current = lastAgent;
  const [collapsedList, setCollapsedList] = React.useState<Record<WandTaskStatus, boolean>>({
    backlog: false, todo: false, doing: false, done: false, archived: true,
  });
  const [draggedId, setDraggedId] = React.useState("");
  const [dropStatus, setDropStatus] = React.useState<WandTaskStatus | "">("");
  const [archiveDrop, setArchiveDrop] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState<{ taskId: string; x: number; y: number } | null>(null);
  const sessionCreationLock = React.useRef(false);
  const [composeRequest, setComposeRequest] = React.useState<{ id: string; nonce: number } | null>(null);
  const loadGenerationRef = React.useRef(0);
  const workspaceGenerationRef = React.useRef(0);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const readingPositions = React.useRef(new Map<string, number>());
  React.useLayoutEffect(() => {
    if (selectedId) return;
    if (pageRef.current) pageRef.current.scrollTop = readingPositions.current.get(view) ?? 0;
    for (const [status, column] of Object.entries(columnScrollRefs.current)) if (column) column.scrollTop = readingPositions.current.get(`column:${status}`) ?? 0;
  }, [selectedId, view]);
  const columnScrollRefs = React.useRef<Partial<Record<WandTaskStatus, HTMLElement>>>({});

  React.useLayoutEffect(() => {
    for (const column of Object.values(columnScrollRefs.current)) if (column) column.scrollTop = 0;
  }, [sort]);

  React.useEffect(() => {
    if (!notice) return;
    wandOverlay.toast(notice, { tone: "success" });
    setNotice("");
  }, [notice]);

  const reload = React.useCallback(async (silent = false): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    if (!silent) { setLoading(true); setError(""); }
    try {
      const next = await taskBoardRepository.list();
      if (generation !== loadGenerationRef.current) return;
      setTasks(next);
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : "无法加载任务。");
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  const loadWorkspaces = React.useCallback(async (): Promise<void> => {
    // 会话模式新建目录时，工作区是在会话创建链路上生成的；看板保持打开时，
    // 不能只依赖 controller.revision，否则「新建任务」里的项目目录会一直停留在旧列表。
    const generation = ++workspaceGenerationRef.current;
    try {
      const next = await taskBoardRepository.workspaces();
      if (generation === workspaceGenerationRef.current) {
        setWorkspaces(next);
        // Never silently broaden results for an invalid URL directory.
      }
    } catch {
      // 轮询失败时保留上一次成功列表，避免瞬时错误把已选目录清掉。
    }
  }, []);

  React.useEffect(() => {
    if (!controller.open) return;
    void reload();
    void loadWorkspaces();
    void taskBoardRepository.models()
      .then((payload) => setCatalog(normalizeIssueModelCatalog(payload)))
      .catch(() => setCatalog(null));
    void aiTeamsRepository.list().then(setTeams).catch(() => setTeams([]));
    let active = true;
    void taskBoardRepository.agentDefaults()
      .then((next) => {
        if (!active) return;
        lastAgentRef.current = next;
        setLastAgent(next);
      })
      .catch(() => undefined);
    const unsubscribe = subscribeWandModelCatalog(setCatalog);
    return () => { active = false; unsubscribe(); };
  }, [controller.open, controller.revision, loadWorkspaces, reload]);

  React.useEffect(() => {
    if (!controller.open) return;
    // 创建器通过共享任务事件通知；看板只维护自身列表轮询。
    const interval = window.setInterval(() => { void loadWorkspaces(); void reload(true); }, 6_000);
    const unsubscribe = subscribeTaskChanges(() => { void reload(true); void loadWorkspaces(); });
    return () => { window.clearInterval(interval); unsubscribe(); };
  }, [controller.open, loadWorkspaces, reload]);

  React.useEffect(() => {
    setError("");
    setNotice("");
    setDetailAgent(null);
    detailChoiceTaskRef.current = "";
    setContextMenu(null);
  }, [controller.revision, controller.open]);

  const runFor = React.useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      mutationPending.current = false;
      setBusyId("");
    }
  }, []);

  const persistDisplay = React.useCallback((next: IssueBoardDisplay) => {
    setDisplay(next);
    writeIssueBoardDisplay(next);
  }, []);

  const rememberAssignment = React.useCallback((agent: WandTaskAgent, subject: TaskExecutionSubject) => {
    const next = parseIssueAssignment({ agent, subject });
    if (!next) return;
    lastAssignmentRef.current = next;
    setLastAssignment(next);
    writeIssueAssignment(next);
  }, []);

  const openCreate = React.useCallback((status: WandTaskStatus = "backlog", parent?: WandTaskListed) => {
    newSessionController.open({ newTask: true,
      taskDraft: { workspaceId: parent ? parent.workspaceId ?? "" : filterWorkspaceId || controller.workspaceId,
        status, parentTaskId: parent?.id, milestoneId: parent?.milestoneId || undefined },
    });
  }, [controller.workspaceId, filterWorkspaceId]);

  const patchTask = React.useCallback(async (id: string, patch: Parameters<typeof taskBoardRepository.update>[1]): Promise<boolean> => {
    let saved = false;
    await runFor(id, async () => {
      try {
        await taskBoardRepository.update(id, patch);
      } catch (cause) {
        if (patch.parentTaskId !== undefined) throw new Error(`父任务归属保存未确认，请先刷新回读后再操作，避免重复提交。${cause instanceof Error ? cause.message : "请求失败。"}`);
        throw cause;
      }
      saved = true;
      await reload();
      if (patch.parentTaskId !== undefined) setNotice("父任务归属已保存，未启动执行。");
    });
    return saved;
  }, [reload, runFor]);

  const removeTask = React.useCallback(async (task: WandTaskListed): Promise<void> => {
    if (!canArchiveBoardTask(task)) return;
    const answer = await wandOverlay.dialog({
      title: `归档「${task.title}」？`,
      description: "任务会移入归档，并将关联的工作任务标为完成。会话记录会保留。",
      actions: [
        { label: "取消", value: false, autoFocus: true },
        { label: "归档任务", value: true, kind: "primary" },
      ],
    });
    if (answer.dismissed === true || !answer.action) return;
    await runFor(task.id, async () => {
      await taskBoardRepository.remove(task.id);
      setNotice(`已归档「${task.title}」，会话记录已保留。`);
      if (selectedId === task.id) {
        setSelectedId("");
        setDetailAgent(null);
      }
      await reload();
    });
  }, [reload, runFor, selectedId]);

  const dispatchTask = React.useCallback(async (task: WandTaskListed, agent: WandTaskAgent, prompt: string): Promise<void> => {
    await runFor(task.id, async () => {
      await taskBoardRepository.update(task.id, { agent, workspaceId: task.workspaceId });
      const result = await taskBoardRepository.dispatch(task.id, agent, {
        prompt: prompt.trim(),
        workspaceId: task.workspaceId,
        subject: { type: "cli", id: agent.provider },
      });
      rememberAssignment(agent, { type: "cli", id: agent.provider });
      setNotice(`${issueAgentLabel(result.session?.provider || agent.provider, agent.engine)} 已开始处理「${task.title}」`);
      await reload();
    });
  }, [rememberAssignment, reload, runFor]);

  // 交给团队：这次输入的提示词就是本轮任务。任务卡上的旧描述不再静默拼进去。
  const dispatchTeam = React.useCallback(async (task: WandTaskListed, team: AiTeam, prompt: string): Promise<void> => {
    await runFor(task.id, async () => {
      const note = prompt.trim();
      const result = await taskBoardRepository.dispatch(task.id, null, {
        prompt: note,
        workspaceId: task.workspaceId,
        subject: { type: "team", id: team.id },
      });
      rememberAssignment(agentOf(task, lastAssignmentRef.current?.agent ?? lastAgentRef.current), { type: "team", id: team.id });
      setNotice(`团队「${team.name}」已开始处理「${task.title}」`);
      setTeamRunRefresh((value) => value + 1);
      await reload();
      // 团队的进展都在群聊里，派完直接带用户过去看。
      if (result.teamRun?.run.id) taskBoardController.open("", "", "teamchat", result.teamRun.run.id);
      else if (result.session?.id) onOpenSession?.(result.session.id);
    });
  }, [onOpenSession, rememberAssignment, reload, runFor]);

  const dispatchEmployee = React.useCallback(async (task: WandTaskListed, employeeId: string, prompt: string, override?: WandTaskAgent): Promise<void> => {
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee) return;
    await runFor(task.id, async () => {
      const result = await taskBoardRepository.dispatch(task.id, override ?? null, {
        prompt: prompt.trim(),
        workspaceId: task.workspaceId,
        subject: { type: "employee", id: employeeId },
        useEmployeeDefaults: !override,
      });
      rememberAssignment(agentOf(task, lastAssignmentRef.current?.agent ?? lastAgentRef.current), { type: "employee", id: employeeId });
      setNotice(result.queued ? `「${task.title}」已排队，等待 ${employee.name} 空闲后自动开始` : `${employee.name} 已开始处理「${task.title}」`);
      await reload();
      if (result.session?.id) onOpenSession?.(result.session.id);
    });
  }, [employees, onOpenSession, rememberAssignment, reload, runFor]);

  // 列内顺序跟 GET /api/wand-tasks 返回顺序走；拖拽只用来换列。
  // 拖进「处理中」代表已经决定要跑：没派发过的任务顺手把首次指派发出去，
  // 省掉「拖完再进详情点一次派发」这一步。
  const dropTask = React.useCallback(async (status: WandTaskStatus, taskId: string) => {
    const moving = tasks.find((task) => task.id === taskId);
    if (!moving || moving.status === status) return;
    const dispatches = issueDropDispatches(status, moving.sessions.length);
    const agent = dispatches ? agentOf(moving, lastAgentRef.current) : null;
    if (mutationPending.current) return;
    let dispatchPrompt = "";
    if (dispatches && agent) {
      dispatchPrompt = issueDropDispatchPrompt(moving);
      const preview = dispatchPrompt.length > 240 ? `${dispatchPrompt.slice(0, 240)}…` : dispatchPrompt;
      const answer = await wandOverlay.dialog({
        title: `用任务说明启动「${moving.title}」？`,
        // 对话层把 description 当一个段落渲染（没有 pre-line），原来的 \n\n 只会变成一个空格，
        // 预览会跟说明粘成一行；这里改成一句连贯的话，用引号把预览括起来。
        description: `拖进「处理中」会按任务卡上已有的这段说明派发，不是指派框里新写的提示词：「${preview}」`,
        actions: [
          { label: "取消", value: "cancel" as const, autoFocus: true },
          { label: "只移入处理中", value: "move" as const },
          { label: "按这段说明派发", value: "dispatch" as const, kind: "primary" },
        ],
      });
      // `dismissed` 是布尔字面量判别式，用 === true 收窄，truthiness 在这里收不掉。
      if (answer.dismissed === true || answer.action === "cancel") return;
      if (answer.action === "move") dispatchPrompt = "";
    }
    await runFor(taskId, async () => {
      await taskBoardRepository.update(taskId, { status });
      let dispatchError = "";
      if (dispatchPrompt && agent) {
        try {
          const result = await taskBoardRepository.dispatch(taskId,
            moving.executionSubject && moving.executionSubject.type !== "cli" ? null : agent, {
            prompt: dispatchPrompt,
            workspaceId: moving.workspaceId,
            subject: moving.executionSubject ?? { type: "cli", id: agent.provider },
          });
          const targetName = moving.executionSubject?.type === "employee"
            ? employees.find((item) => item.id === moving.executionSubject?.id)?.name
            : moving.executionSubject?.type === "team"
              ? teams?.find((item) => item.id === moving.executionSubject?.id)?.name
              : issueAgentLabel(result.session?.provider || agent.provider, agent.engine);
          setNotice(result.queued
            ? `「${moving.title}」已排队，等待 ${targetName || "员工"} 空闲后自动开始`
            : `${targetName || issueAgentLabel(result.session?.provider || agent.provider, agent.engine)} 已开始处理「${moving.title}」`);
        } catch (cause) {
          // 状态已经改好，派发失败只提示、不回滚：用户可进详情改参数后重试。
          dispatchError = cause instanceof Error ? cause.message : "任务已移入「处理中」，但派发 Agent 失败。";
        }
      }
      await reload();
      // reload() 开头会清掉错误横幅，所以派发失败的提示必须放在它之后才留得住。
      if (dispatchError) setError(dispatchError);
    });
  }, [employees, reload, runFor, tasks, teams]);

  // 归档也是软删除：卡片进归档目录、侧栏任务隐藏，终端与执行记录全部保留。
  const archiveCard = React.useCallback(async (taskId: string): Promise<void> => {
    const moving = tasks.find((task) => task.id === taskId);
    if (!moving || moving.status === "archived" || !canArchiveBoardTask(moving)) return;
    await runFor(taskId, async () => {
      await taskBoardRepository.update(taskId, { status: "archived" });
      // 归档后从普通列表消失，只有主动查看归档时才展示。
      setCollapsedList((current) => ({ ...current, archived: true }));
      setNotice(`已归档「${moving.title}」，拖回任意列或右键「恢复到等待认领」即可恢复。`);
      await reload();
    });
  }, [reload, runFor, tasks]);

  // 恢复归档卡片：卡片回到「等待认领」，侧栏任务由服务端反向投影重新出现。
  const restoreCard = React.useCallback(async (taskId: string): Promise<void> => {
    const moving = tasks.find((task) => task.id === taskId);
    if (!moving || moving.status !== "archived") return;
    await runFor(taskId, async () => {
      await taskBoardRepository.update(taskId, { status: "todo" });
      setNotice(`已恢复「${moving.title}」到「等待认领」。`);
      await reload();
    });
  }, [reload, runFor, tasks]);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const selectedChildren = selected ? tasks.filter((task) => task.parentTaskId === selected.id) : [];
  const archiveOpen = issueArchiveFolderOpen(collapsedList.archived, query, filters);
  const [executionQueue, setExecutionQueue] = React.useState(false);
  const matches = filterIssues(tasks, query, filterWorkspaceId, filters, archiveOpen);
  const visible = sortTaskBoardTasks(executionQueue ? matches : taskGoalProjection(tasks, matches), sort);
  const grouped = groupIssuesByStatus(visible);
  const matchedTasks = filterIssues(tasks, query, filterWorkspaceId, filters, true);
  const counted = executionQueue ? matchedTasks : taskGoalProjection(tasks, matchedTasks);
  const activeCount = counted.filter((task) => task.status !== "archived").length;
  const archiveCount = counted.length - activeCount;
  // 「清空归档」删的是当前项目范围内全部归档卡片，不受搜索和筛选影响，确认框按这个数量说话。
  const archivePurgeScope = tasks.filter((task) => task.status === "archived"
    && (!filterWorkspaceId || task.workspaceId === filterWorkspaceId)).length;
  // 清空归档是硬删除，不可恢复；范围跟随当前项目筛选，服务端会跳过名下会话还在处理的卡片。
  const [archivePurging, setArchivePurging] = React.useState(false);
  const purgeArchive = React.useCallback(async (): Promise<void> => {
    const answer = await wandOverlay.dialog({
      title: `永久删除 ${archivePurgeScope} 个归档任务？`,
      description: "归档卡片会被彻底删除，无法恢复；仍在运行的会话名下的任务会被跳过。",
      actions: [
        { label: "取消", value: false, autoFocus: true },
        { label: "永久删除", value: true, kind: "danger" },
      ],
    });
    if (answer.dismissed === true || answer.action !== true) return;
    if (mutationPending.current) return;
    mutationPending.current = true;
    setArchivePurging(true);
    setError("");
    try {
      const result = await taskBoardRepository.purgeArchived(filterWorkspaceId || null);
      setNotice(result.skipped > 0
        ? `已删除 ${result.deleted} 个归档任务，${result.skipped} 个仍在处理已跳过。`
        : `已删除 ${result.deleted} 个归档任务。`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法清空归档任务。");
    } finally {
      mutationPending.current = false;
      setArchivePurging(false);
    }
  }, [archivePurgeScope, filterWorkspaceId, reload]);
  const workspaceOptions = issueWorkspaceOptions(workspaces);
  const projectName = filterWorkspaceId
    ? workspaces.find((workspace) => workspace.id === filterWorkspaceId)?.name ?? "项目"
    : "所有项目";
  const mainColumns = ISSUE_COLUMNS.filter((column) => display.mainStatuses.includes(column.status));
  const otherColumns = ISSUE_COLUMNS.filter((column) => !display.mainStatuses.includes(column.status));
  const detailBusy = selected ? busyId === selected.id : false;
  const detailAgentValue = detailAgent ?? (selected ? agentOf(selected, lastAgent) : lastAgent);
  const contextTask = contextMenu ? tasks.find((task) => task.id === contextMenu.taskId) ?? null : null;
  const filterActive = issueFilterCount(filters) > 0;
  const emptyState = issueBoardEmptyState(tasks.length, activeCount, archiveCount, Boolean(query.trim() || filterActive));
  // Compare the saved configuration by value, not the fresh objects returned by polling.
  const selectedAgentKey = JSON.stringify(selected?.agent ?? null);
  React.useEffect(() => {
    if (!selected) {
      detailChoiceTaskRef.current = "";
      setDetailAgent(null);
      return;
    }
    if (detailChoiceTaskRef.current === selected.id
      && (!employeeTarget || employeesLoading || employeesError || employees.some((item) => item.id === employeeTarget && !item.archivedAt))
      && (!teamTarget || teams === null || teams.some((item) => item.id === teamTarget))) return;
    detailChoiceTaskRef.current = "";
    const assignment = resolveIssueAssignment(selected, lastAssignment, lastAgent, {
      employees: employeesLoading || employeesError ? null : employees, teams,
    });
    setEmployeeOverride(!!assignment.subject.agentOverride);
    setDetailAgent(assignment.subject.agentOverride ?? (assignment.subject.type === "employee" ? employees.find(item => item.id === assignment.subject.id)?.agents[0] ?? assignment.agent : assignment.agent));
    setTeamTarget(assignment.subject.type === "team" ? assignment.subject.id : "");
    setEmployeeTarget(assignment.subject.type === "employee" ? assignment.subject.id : "");
  }, [selected?.id, selectedAgentKey, selected?.executionSubject?.type, selected?.executionSubject?.id, lastAgent, lastAssignment, employeeTarget, employees, employeesError, employeesLoading, teamTarget, teams]);

  // URL owns result filters; device preferences cannot override shared links.

  // 展开选择随面板保留；过滤仅改变可见投影，不清除返回位置。

  React.useEffect(() => {
    const previous = document.title;
    document.title = selected ? `${selected.title} · Wand` : "任务看板 · Wand";
    return () => { document.title = previous; };
  }, [selected?.title]);

  React.useEffect(() => {
    if (!controller.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || newSessionController.isOpen()) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return;
      const typing = target instanceof HTMLElement && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
      );
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "c" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        openCreate("backlog");
        return;
      }
      if (event.key !== "Escape" || typing) return;
      if (selectedId) {
        setSelectedId("");
        return;
      }
      // 展开的卡片先收起，再谈离开看板：Esc 一次只退一层。
      if (expandedTaskId) {
        setExpandedTaskId("");
        return;
      }
      onBack ? onBack() : taskBoardController.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller.open, expandedTaskId, onBack, openCreate, selectedId]);

  if (!controller.open) return null;

  const renderCard = (task: WandTaskListed): React.ReactElement => {
    const assigned = task.agent;
    const busy = busyId === task.id;
    const parent = tasks.find((item) => item.id === task.parentTaskId);
    const childCount = tasks.filter((item) => item.parentTaskId === task.id).length;
    const expanded = expandedTaskId === task.id;
    // 拖拽所有权留在原生 article；表面和展开内容由 Ant 组件管理。
    return <article
      key={task.id}
      className={classNames(
        "task-board-card",
        `is-${task.status}`,
        expanded && "is-open",
        draggedId === task.id && "is-dragging",
        dropStatus === task.status && draggedId && draggedId !== task.id && "is-shift",
        busy && "is-busy",
        sessionDropTarget === task.id && "is-session-drop-target",
      )}
      onDragOver={(event) => {
        if (busy || !isSessionDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setSessionDropTarget(task.id);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSessionDropTarget("");
      }}
      onDrop={(event) => {
        if (!isSessionDrag(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        setSessionDropTarget("");
        const id = draggedSessionId(event.dataTransfer);
        if (!id || busy || task.sessions.some((session) => session.id === id)) return;
        void runFor(task.id, async () => {
          await taskBoardRepository.moveSession(task.id, id);
          setNotice(`已移入「${task.title}」，运行目录不变`);
          await reload();
          await workspacesStore.getRuntime()?.refreshSessions();
        });
      }}
      data-task-id={task.id}
      draggable={!busy}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setContextMenu({ taskId: task.id, x: rect.left + 16, y: rect.top + 32 });
      }}
      onDragStart={(event) => {
        if (event.target !== event.currentTarget) return;
        // 拖走的是展开中的卡片时先收起，别让面板跟着卡片进列。
        setExpandedTaskId("");
        startTaskDrag(event.dataTransfer, task.id);
        setDraggedId(task.id);
      }}
      onDragEnd={() => {
        setDraggedId("");
        setDropStatus("");
        setArchiveDrop(false);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
      }}
    >
      <Card size="small" styles={{ body: { padding: 12 } }} loading={busy}>
      <Flex vertical gap="small">
      <Flex align="flex-start" gap={4} className="task-board-card-heading">
      <WandButton kind="ghost"
        type="button"
        ref={bindCardTrigger(task.id)}
        className="task-board-card-open"
        style={{ height: "auto", width: "100%", justifyContent: "flex-start", whiteSpace: "normal", textAlign: "left" }}
        aria-expanded={expanded}
        aria-controls={`task-card-detail-${task.id}`}
        aria-label={`${expanded ? "收起" : "展开"} ${task.identifier}: ${task.title}`}
        title={task.title || "未命名任务"}
        onClick={() => setExpandedTaskId((current) => current === task.id ? "" : task.id)}
      ><Typography.Text strong className="task-board-card-title" id={`task-${task.id}-title`}>{task.title || "未命名任务"}</Typography.Text></WandButton>
      <WandIconButton className="task-board-card-menu" aria-label={`任务菜单 ${task.identifier}`} disabled={busy}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setContextMenu({ taskId: task.id, x: rect.left, y: rect.bottom }); }}>
        <WandIcon name="more" size={16}/>
      </WandIconButton>
      </Flex>
      {display.body && task.description && !expanded
        ? <p className="task-board-card-body">{task.description}</p>
        : null}
      <Typography.Text type={task.acceptance?.acceptedAt ? "success" : "secondary"}>{taskAcceptanceLabel(task.acceptance)}</Typography.Text>
      <Flex wrap gap={4} align="center" className="task-board-card-meta" aria-label="任务属性">
        <span className="task-board-card-id">{task.identifier}</span>
        {parent && <span className="task-board-chip is-parent" title={`归属 ${parent.identifier} · ${parent.title}`}>
          ↳ {parent.identifier}
        </span>}
        {childCount > 0 && <span className="task-board-chip is-parent" title={`${childCount} 个子任务`}>
          {childCount} 个子任务
        </span>}
        <TaskBoardProjectChip name={task.workspace ? task.workspace.name : "未归属工作区"}/>
        {task.milestone ? <TaskBoardMilestoneChip name={task.milestone.name}/> : null}
        <TaskBoardPriorityChip priority={task.priority}/>
        {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
        {task.labels.length > 2 ? <span className="task-board-label-more">+{task.labels.length - 2}</span> : null}
        {task.dueDate ? <span className={classNames("task-board-due", issueIsOverdue(task.dueDate, task.status) && "is-overdue")}>
          {issueDueStamp(task.dueDate)}
        </span> : null}
        <TaskBoardAgentChips sessions={task.sessions} assigned={assigned} subject={task.executionSubject} assignee={task.assignedExecutor}/>
        {task.status !== "doing" && <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>}
        <TaskBoardCommentCountButton task={task} onOpen={() => setSelectedId(task.id)}/>
      </Flex>
      <TaskGoalChildren task={task} tasks={tasks} onOpen={setSelectedId}/>
      {sessionDropTarget === task.id && <Alert type="info" showIcon title="移入此任务 · 运行目录不变"/>}
      {task.sessions.length > 0 && <Flex vertical gap={4} className="task-board-session-list" style={{ display: expanded ? "none" : undefined }} aria-label={`${task.title} 的会话`}>
        {task.sessions.slice(0, 2).map((session) => <Flex key={session.id} align="center" justify="space-between" gap={4} className="task-board-session-row" style={{ minWidth: 0 }}
          data-session-id={session.id} draggable={!busy}
          onDragStart={(event) => { event.stopPropagation(); startSessionDrag(event.dataTransfer, session.id); }}>
          <WandButton kind="ghost" type="button" className="task-board-session-open" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }} title={`${session.title}\n${session.cwd}`}
            onClick={() => onOpenSession?.(session.id)}>
            <WandIcon name="terminal" size={13}/><Typography.Text ellipsis style={{ flex: 1, minWidth: 0, textAlign: "left" }}>{session.title || session.provider || "CLI 会话"}</Typography.Text>
          </WandButton>
          <SessionMoveButton sessionId={session.id} taskId={task.workspaceTaskId ?? undefined}/>
        </Flex>)}
        {task.sessions.length > 2 && <WandButton kind="ghost" size="small" className="task-board-session-more" onClick={() => setExpandedTaskId(task.id)}>查看全部 {task.sessions.length} 个会话</WandButton>}
      </Flex>}
      {task.status === "doing"
        ? <TaskBoardProcessingRow task={task} onOpenSession={onOpenSession}/>
        : null}
      <TaskBoardCardDetail
        task={task}
        open={expanded}
        parentLabel={parent?.title}
        childCount={childCount}
        onOpen={setSelectedId}
        onCollapse={() => setExpandedTaskId("")}
        onOpenSession={onOpenSession}
      />
      </Flex></Card>
    </article>;
  };

  const renderColumn = (status: WandTaskStatus): React.ReactElement => {
    const column = columnOf(status);
    const items = grouped[status];
    return <section
      key={status}
      className={classNames("task-board-column", `is-${status}`, dropStatus === status && "is-drop-target")}
      style={{ flex: "1 0 280px", minWidth: 0 }}
      aria-labelledby={`column-${status}`}
      onDragEnter={(event) => { if (isTaskDrag(event.dataTransfer)) setDropStatus(status); }}
      onDragOver={(event) => {
        if (!isTaskDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropStatus(status);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDropStatus((current) => current === status ? "" : current);
      }}
      onDrop={(event) => {
        if (isSessionDrag(event.dataTransfer)) return;
        event.preventDefault();
        const id = draggedTaskId(event.dataTransfer);
        setDropStatus("");
        setDraggedId("");
        if (id && tasks.some((task) => task.id === id)) void dropTask(status, id);
      }}
    >
      <Flex component="header" align="center" justify="space-between" gap="small" className="task-board-column-head">
        <Flex align="center" gap="small" className="task-board-column-heading">
          <TaskBoardStatusGlyph status={status}/>
          <Typography.Title level={5} id={`column-${status}`} style={{ margin: 0 }}>{column.label}</Typography.Title>
          <span className="task-board-column-count">{items.length}</span>
        </Flex>
        <div className="task-board-column-actions">
          <WandIconButton
            className="task-board-icon-button"
            aria-label={`在${column.label}中新建任务`}
            title={`添加到${column.label}`}
            onClick={() => openCreate(status)}
          >
            <WandIcon name="plus"/>
          </WandIconButton>
        </div>
      </Flex>
      <Flex vertical gap="small" className="task-board-column-list" data-scroll-status={status} ref={(node) => { columnScrollRefs.current[status] = node ?? undefined; }}>
        {loading && tasks.length === 0
          ? <>
              <WandSkeleton className="task-board-skeleton"/>
              <WandSkeleton className="task-board-skeleton"/>
            </>
          : null}
        {!loading && items.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
        {items.map(renderCard)}

      </Flex>
    </section>;
  };

  return <Flex component="section" vertical gap="middle" className="task-board-native-page" aria-label="任务管理"
    ref={pageRef}
    onScrollCapture={event => {
      if (selectedId || !(event.target instanceof HTMLElement)) return;
      const status = event.target.dataset.scrollStatus;
      if (status) readingPositions.current.set(`column:${status}`, event.target.scrollTop);
      else if (event.target === pageRef.current) readingPositions.current.set(view, event.target.scrollTop);
    }}
    data-view={view} data-detail={Boolean(selected)}>
    <Flex component="header" wrap align="center" justify="space-between" gap="small" className="task-board-workspace-header">
      <Flex align="center" gap="small" className="task-board-kicker">
        {onOpenSidebar ? (
          <WandIconButton
            className="task-board-icon-button"
            aria-label={sidebarOpen ? "关闭任务列表" : "打开任务"}
            onClick={onOpenSidebar}
          >
            <SidebarToggleIcon open={sidebarOpen} size={16}/>
          </WandIconButton>
        ) : null}
        {!selected ? <WandIconButton
          className="task-board-icon-button"
          aria-label="返回工作区"
          title="返回工作区"
          onClick={() => onBack ? onBack() : taskBoardController.close()}
        >
          <WandIcon name="chevronLeft"/>
        </WandIconButton> : null}
        <div className="task-board-heading-copy">
          {selected ? <WandBreadcrumb
            variant="title"
            ariaLabel="任务看板导航"
            items={[
              { label: "任务看板", onNavigate: () => setSelectedId("") },
              { label: selected.identifier },
            ]}
          /> : <>
            <h1>任务看板</h1>
          </>}
        </div>
      </Flex>
      <Flex wrap gap="small" className="task-board-header-actions">
        <CopyPageLink label={selectedId ? "复制任务链接" : "复制当前页面链接"}/>
        {!selected && <>
          <WandSwitch checked={executionQueue} onCheckedChange={setExecutionQueue} ariaLabel="子任务执行队列"/>
          <Typography.Text>{executionQueue ? "包含子任务的执行队列" : "主目标视图"}</Typography.Text>
          <TaskOrganizeButton target={filterWorkspaceId ? { kind: "workspace", workspaceId: filterWorkspaceId } : { kind: "all" }} onChanged={() => reload(true)}/>
          <WandIconButton disabled={loading} onClick={() => void reload()} aria-label="刷新任务" title="刷新任务">
            <WandIcon name="refresh"/>
          </WandIconButton>
          <WandButton
            className="task-board-create-button"
            kind="primary"
            size="medium"
            aria-label="新建任务"
            title="新建任务 (C)"
            onClick={() => openCreate("backlog")}
          >
            <WandIcon name="plus" slot="start"/>
            <span>新建任务</span>
          </WandButton>
        </>}
      </Flex>
    </Flex>
    {!selected && <Flex wrap align="center" justify="space-between" gap="small" className="task-board-toolbar">
      {!selected && <WandStretchTabs
        className="task-board-view-tabs"
        ariaLabel="看板视图"
        value={view}
        onValueChange={(next) => setView(next as IssueBoardView)}
        tabs={ISSUE_BOARD_VIEWS.map((entry) => ({
          value: entry.value,
          label: entry.label,
        }))}
      />}

      <Flex wrap align="center" gap="small" className="task-board-toolbar-controls">
        <WandSearchField inputRef={searchRef} className="task-board-search" label="搜索任务" placeholder="搜索标题、编号或正文" value={query} onValueChange={setQuery}/>
        <WandSelect
          className="task-board-workspace-filter"
          value={filterWorkspaceId || "__all__"}
          options={[{ value: "__all__", label: "所有目录" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]}
          ariaLabel="筛选工作目录"
          searchable
          searchPlaceholder="搜索目录"
          onValueChange={(value) => setFilterWorkspaceId(value === "__all__" ? "" : value)}
        />
        <WandSelect className="task-board-sort" ariaLabel="任务排序" value={sort} options={TASK_BOARD_SORTS} onValueChange={(value) => setSort(value as TaskBoardSort)}/>
          {(view === "board" || view === "list" || view === "gantt") && <TaskBoardFilterMenu
            tasks={tasks}
            filters={filters}
            onChange={setFilters}
          />}
          {view === "board" && <TaskBoardDisplayMenu display={display} onChange={persistDisplay}/>}
      </Flex>
    </Flex>}
    {!selected && <Flex wrap align="center" justify="space-between" gap="small" className="task-board-result-summary" role="status">
      <span>{loading ? "正在同步任务…" : `${executionQueue ? "任务" : "主目标"} ${activeCount} · 归档 ${archiveCount} · 子任务 ${matchedTasks.filter(task => task.parentTaskId).length} · 执行会话 ${new Set(matchedTasks.flatMap(task => task.sessions.map(session => session.id))).size}`}{(query || filterActive || filterWorkspaceId) ? " · 已筛选" : ""}</span>
      <Flex wrap gap={4} className="task-board-active-filters">
        {filters.statuses.map((status) => <WandButton kind="ghost" size="small" key={status} aria-label={`移除状态筛选 ${columnOf(status).label}`} onClick={() => setFilters({ ...filters, statuses: filters.statuses.filter((entry) => entry !== status) })}>{status === "archived" ? "归档任务" : columnOf(status).label}<WandIcon name="close" size={12}/></WandButton>)}
        {filters.priorities.map((priority) => <WandButton kind="ghost" size="small" key={priority} aria-label={`移除优先级筛选 ${priority}`} onClick={() => setFilters({ ...filters, priorities: filters.priorities.filter((entry) => entry !== priority) })}>{ISSUE_PRIORITIES.find((entry) => entry.value === priority)?.label}<WandIcon name="close" size={12}/></WandButton>)}
        {filters.labels.map((label) => <WandButton kind="ghost" size="small" key={label} aria-label={`移除标签筛选 ${label}`} onClick={() => setFilters({ ...filters, labels: filters.labels.filter((entry) => entry !== label) })}>{label}<WandIcon name="close" size={12}/></WandButton>)}
      </Flex>
      {(query || filterActive || filterWorkspaceId) && <WandButton kind="ghost" size="small" onClick={() => {
        setQuery(""); setFilters(EMPTY_ISSUE_FILTERS); setFilterWorkspaceId(""); searchRef.current?.focus();
      }}>清除筛选</WandButton>}
    </Flex>}

    {!selected && !loading && activeCount === 0 && archiveCount > 0 && !archiveOpen && <Alert type="info" showIcon title="当前没有活动任务"
      description={`有 ${archiveCount} 个归档任务。展开归档可查看历史，归档不会启动或停止执行。`}
      action={<WandButton kind="ghost" size="small" onClick={() => setCollapsedList((current) => ({ ...current, archived: false }))}>展开归档</WandButton>}/>}
    {selectedId && !selected && !loading && !error && <Alert type="warning" showIcon title="任务不存在、已删除或无权访问" action={<WandButton onClick={() => setSelectedId("")}>返回任务看板</WandButton>}/>}
    {filterWorkspaceId && !workspaces.some(item => item.id === filterWorkspaceId) && !loading && <Alert type="warning" title="链接中的目录不可用" action={<WandButton onClick={() => setFilterWorkspaceId("")}>查看所有目录</WandButton>}/>}
    {error && <Alert type="error" role="alert" showIcon title={error} action={<WandButton kind="ghost" size="small" disabled={loading} onClick={() => void reload()}>重新加载</WandButton>}/>}

    {selected ? <IssueDetail
      task={selected}
      busy={detailBusy}
      catalog={catalog}
      agent={detailAgentValue}
      providerOptions={providerOptions}
      teams={teams}
      teamId={teamTarget}
      employees={employees}
      employeeId={employeeTarget}
      employeeOverride={employeeOverride}
      teamRunRefresh={teamRunRefresh}
      onTeamChange={setTeamTarget}
      onEmployeeChange={setEmployeeTarget}
      workspaceOptions={workspaceOptions}
      parent={tasks.find((task) => task.id === selected.parentTaskId) ?? null}
      children={selectedChildren}
      parentOptions={issueParentOptions(tasks, selected.workspaceId, selected.id, selected.parentTaskId)}
      onOpenTask={setSelectedId}
      onCreateChild={() => openCreate("backlog", selected)}
      onAgentChange={(agent, subject, override) => {
        setEmployeeOverride(override === true);
        detailChoiceTaskRef.current = selected.id;
        setDetailAgent(agent);
        rememberAssignment(agent, subject ?? { type: "cli", id: agent.provider });
      }}
      onPatch={(patch) => patchTask(selected.id, patch)}
      composeRequest={composeRequest}
      onDispatch={(prompt) => {
        const team = teams?.find((item) => item.id === teamTarget);
        const employee = employees.find(item => item.id === employeeTarget);
        const executionPrompt = buildTaskDispatchPrompt(selected, tasks.find(item => item.id === selected.parentTaskId), prompt);
        void wandOverlay.dialog({
          title: "确认新建一次执行",
          description: `${executionPrompt}\n\n执行配置：${team?.name || taskDispatchConfiguration(detailAgentValue, employeeOverride ? undefined : employee)}\n沿用现有权限与费用边界；已有会话请从执行记录精确继续，此处新建执行，不代表验收通过。`,
          actions: [{ label: "取消", value: false, autoFocus: true }, { label: "确认派发", value: true, kind: "primary" }],
        }).then(answer => { if (answer.dismissed !== true && answer.action === true) return team ? dispatchTeam(selected, team, executionPrompt)
          : employeeTarget ? dispatchEmployee(selected, employeeTarget, executionPrompt, employeeOverride ? detailAgentValue : undefined) : dispatchTask(selected, detailAgentValue, executionPrompt); });
      }}
      onRemove={() => void removeTask(selected)}
      onOpenSession={onOpenSession}
    /> : !loading && matchedTasks.length === 0 ? <div className="task-board-no-results" role="status">
      <WandIcon name={emptyState.kind === "filtered" ? "search" : "board"} size={24}/>
      <h2>{emptyState.title}</h2>
      <p>{emptyState.description}</p>
      <WandButton kind={emptyState.kind === "filtered" ? "secondary" : "primary"} onClick={() => {
        if (emptyState.kind === "filtered") {
          setQuery(""); setFilters(EMPTY_ISSUE_FILTERS); setFilterWorkspaceId(""); searchRef.current?.focus();
        } else openCreate("backlog");
      }}>{emptyState.kind === "filtered" ? "清除筛选" : "新建任务"}</WandButton>
    </div> : view === "dashboard" ? <TaskBoardDashboard
      projectName={projectName}
      tasks={visible}
      allTasks={tasks}
      onOpen={setSelectedId}
      onOpenSession={onOpenSession}
    /> : view === "list" ? <TaskBoardListView
      grouped={grouped}
      allTasks={tasks}
      collapsed={collapsedList}
      archiveOpen={archiveOpen}
      archiveCount={archiveCount}
      onToggle={(status) => setCollapsedList((current) => ({ ...current, [status]: !current[status] }))}
      onToggleArchive={() => setCollapsedList((current) => ({ ...current, archived: !current.archived }))}
      onPurgeArchive={() => void purgeArchive()}
      archivePurging={archivePurging}
      onOpen={setSelectedId}
      onOpenSession={onOpenSession}
      onOpenComments={id => setSelectedId(id)}
    /> : view === "gantt" ? <TaskBoardGantt
      allTasks={tasks}
      grouped={grouped}
      zoom={ganttZoom}
      hideCompleted={ganttHideCompleted}
      onZoom={setGanttZoom}
      onHideCompleted={setGanttHideCompleted}
      onOpen={setSelectedId}
    /> : <Flex vertical gap="middle" className={classNames("task-board-layout", otherColumns.length > 0 && "has-other-tasks")}>
      <div className="task-board-scroll" tabIndex={0} aria-label="任务状态列">
        <Flex gap="middle" align="stretch" className="task-board-board" style={{ minWidth: Math.max(mainColumns.length, 1) * 280, "--task-board-columns": Math.max(mainColumns.length, 1) } as React.CSSProperties}>
          {mainColumns.map((column) => renderColumn(column.status))}
        </Flex>
      </div>
      {otherColumns.length > 0 && <Flex component="aside" wrap gap="middle" className="task-board-other" aria-label="其他任务">
        {otherColumns.map((column) => renderColumn(column.status))}
      </Flex>}
      {archiveCount > 0 || draggedId ? (
        <Card size="small"
          styles={{ body: { padding: 12 } }}
          style={{ borderColor: archiveDrop ? "var(--accent)" : undefined }}
          className={classNames(
            "task-board-archive-zone",
            draggedId && "is-dragging-task",
            archiveDrop && "is-over",
          )}
          aria-label="归档区"
          onDragOver={(event) => {
            if (!isTaskDrag(event.dataTransfer)) return;
            const moving = tasks.find(task => task.id === event.dataTransfer.getData(TASK_DRAG_TYPE))
              ?? tasks.find(task => task.id === draggedId);
            if (!moving || !canArchiveBoardTask(moving)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setArchiveDrop(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setArchiveDrop(false);
          }}
          onDrop={(event) => {
            if (!isTaskDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            setArchiveDrop(false);
            setDraggedId("");
            setDropStatus("");
            const id = event.dataTransfer.getData(TASK_DRAG_TYPE);
            if (id) void archiveCard(id);
          }}
        >
          <TaskBoardArchiveFolder
            count={archiveCount}
            open={archiveOpen}
            onPurge={() => void purgeArchive()}
            purging={archivePurging}
            onToggle={() => setCollapsedList((current) => ({ ...current, archived: !current.archived }))}
          >
            <div className="task-board-archive-cards">
              {grouped.archived.map(renderCard)}
            </div>
          </TaskBoardArchiveFolder>
          {draggedId ? <Alert className="task-board-archive-hint" type={archiveDrop ? "info" : "warning"} showIcon
            title={archiveDrop ? "松开鼠标，归档此任务" : "拖到这里归档：侧栏隐藏，终端与记录保留"}/> : null}
        </Card>
      ) : null}
    </Flex>}

    {contextTask && contextMenu && <TaskBoardContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      task={contextTask}
      onOpen={() => {
        setSelectedId(contextTask.id);
        setContextMenu(null);
      }}
      onCopy={() => {
        void navigator.clipboard?.writeText(contextTask.identifier);
        setContextMenu(null);
      }}
      onNewSession={() => {
        setContextMenu(null);
        if (sessionCreationLock.current) return;
        sessionCreationLock.current = true;
        void openTaskSessionCreation(contextTask, { canContinue: () => taskBoardStore.getSnapshot().open })
          .catch(error => { if (taskBoardStore.getSnapshot().open) setNotice(error instanceof Error ? error.message : "无法打开新建会话。"); })
          .finally(() => { sessionCreationLock.current = false; });
      }}
      onDispatch={() => {
        // 右键「派发」只打开空的指派框。任务卡描述不再被当成这次的提示词直接发出去。
        setSelectedId(contextTask.id);
        setComposeRequest({ id: contextTask.id, nonce: Date.now() });
        setContextMenu(null);
      }}
      onArchive={() => {
        void removeTask(contextTask);
        setContextMenu(null);
      }}
      onRestore={() => {
        void restoreCard(contextTask.id);
        setContextMenu(null);
      }}
      onClose={() => setContextMenu(null)}
    />}

  </Flex>;
}

function IssueDetail({
  task,
  busy,
  catalog,
  agent,
  providerOptions,
  teams,
  teamId,
  employees,
  employeeId,
  employeeOverride,
  teamRunRefresh,
  onTeamChange,
  onEmployeeChange,
  workspaceOptions,
  parent,
  children,
  parentOptions,
  onOpenTask,
  onCreateChild,
  onAgentChange,
  onPatch,
  onDispatch,
  onRemove,
  onOpenSession,
  composeRequest,
}: {
  task: WandTaskListed;
  busy: boolean;
  catalog: IssueModelCatalog | null;
  agent: WandTaskAgent;
  providerOptions: Array<{ value: string; label: string }> | null;
  teams: AiTeam[] | null;
  teamId: string;
  employees: ReturnType<typeof useSiliconEmployees>["employees"];
  employeeId: string;
  employeeOverride: boolean;
  teamRunRefresh: number;
  onTeamChange(teamId: string): void;
  onEmployeeChange(employeeId: string): void;
  workspaceOptions: ReturnType<typeof issueWorkspaceOptions>;
  parent: WandTaskListed | null;
  children: WandTaskListed[];
  parentOptions: ReturnType<typeof issueParentOptions>;
  onOpenTask(id: string): void;
  onCreateChild(): void;
  onAgentChange(agent: WandTaskAgent, subject?: TaskExecutionSubject, employeeOverride?: boolean): void;
  onPatch(patch: Parameters<typeof taskBoardRepository.update>[1]): Promise<boolean>;
  onDispatch(prompt: string): void;
  onRemove(): void;
  onOpenSession?: (sessionId: string) => void;
  composeRequest: { id: string; nonce: number } | null;
}): React.ReactElement {
  const [title, setTitle] = React.useState(task.title);
  const [labelDraft, setLabelDraft] = React.useState(task.labels.join(", "));
  const [composeOpen, setComposeOpen] = React.useState(false);
  const [composePrompt, setComposePrompt] = React.useState(() => taskDispatchDrafts.get(task.id) ?? "");
  const knownLabels = collectIssueLabels([task]);
  const labelKey = task.labels.join("\0");
  const workspaceSelectOptions = React.useMemo(() => {
    const options = [...workspaceOptions];
    if (task.workspaceId && task.workspace && !options.some((item) => item.value === task.workspaceId)) {
      options.splice(1, 0, {
        value: task.workspace.id,
        label: `${task.workspace.name} · ${task.workspace.cwd}`,
      });
    }
    return options;
  }, [task.workspace, task.workspaceId, workspaceOptions]);

  // 看板会静默轮询 + 跟随会话变更刷新，task 每次都是新对象（labels 数组换了引用）。
  // 因此派生草稿只按「值」同步，否则一次刷新就会把用户正在编辑的标题/标签打回原样。
  React.useEffect(() => {
    setTitle(task.title);
    setLabelDraft(task.labels.join(", "));
  }, [task.id, task.title, labelKey]);

  // 指派面板只在切换任务或会话数真的变了（派发成功挂上新会话）时重置；
  // 静默刷新不能把刚打开的面板和已经输入的提示词一起关掉。
  const sessionCount = task.sessions.length;
  React.useEffect(() => {
    setComposeOpen(false);
    setComposePrompt(taskDispatchDrafts.get(task.id) ?? "");
  }, [task.id, sessionCount]);

  React.useEffect(() => {
    if (composeRequest?.id !== task.id) return;
    onEmployeeChange("");
    setComposeOpen(true);
    setComposePrompt(taskDispatchDrafts.get(task.id) ?? "");
  }, [composeRequest, task.id]);

  return <Flex vertical gap="middle" className="task-board-detail" aria-label="任务详情">
    <div className="task-board-detail-scroll">
      <Flex wrap gap="middle" className="task-board-detail-layout">
        <Flex vertical gap="middle" className="task-board-detail-main" style={{ flex: "2 1 380px", minWidth: 0 }}>
          {parent && <WandButton kind="ghost" className="task-board-parent-link" type="button" onClick={() => onOpenTask(parent.id)}>
            ↳ 归属 {parent.identifier} · {parent.title}
          </WandButton>}
          <TaskTextArea
            className="resize-none task-board-detail-title"
            autoSize={{ minRows: 1 }}
            value={title}
            aria-label="任务标题"
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value.replace(/\n/g, "");
              setTitle(value);
            }}
            onBlur={() => {
              if (!title.trim() || title.trim() === task.title) return;
              onPatch({ title: title.trim() });
            }}
          />
          <Flex wrap align="center" gap="small" aria-label="任务负责人">
            <Typography.Text type="secondary">负责人</Typography.Text>
            <TaskBoardAgentChips sessions={task.sessions} assigned={task.agent} subject={task.executionSubject} assignee={task.assignedExecutor}/>
          </Flex>
          <TaskDescription key={task.id} description={task.description} busy={busy} onSave={value => onPatch({ description: value })}/>
          <TaskReferenceableTasks key={`references-${task.id}`} children={children} onOpenTask={onOpenTask} onOpenSession={onOpenSession}
            onCreateChild={!task.parentTaskId && task.status !== "archived" ? onCreateChild : undefined}/>
          <Collapse ghost items={[{ key: "execution", label: `本任务执行汇总 · ${task.sessions.length} 个会话`, children:
            <TaskSessionSummary task={task} onOpenSession={onOpenSession} onNewParallel={() => {
              onEmployeeChange("");
              setComposeOpen(true);
            }}/>,
          }]}/>
          <Collapse ghost className="task-board-acceptance-collapse" items={[{ key: "acceptance", label: <Typography.Text strong>{children.length ? "主任务整体验收" : "交付与验收"} · {taskAcceptanceLabel(task.acceptance)}</Typography.Text>,
            children: <TaskAcceptanceEditor key={`acceptance-${task.id}`} task={task} children={children} busy={busy} onSave={acceptance => onPatch({ acceptance })}/> }]}/>
          <TaskComments key={`comments-${task.id}`} taskId={task.id} updatedAt={task.updatedAt} employees={employees}
            childTasks={children} sessions={task.sessions} onOpenSession={onOpenSession} onOpenTask={onOpenTask}/>
          {composeOpen ? <Card size="small" className="task-board-native-assign" aria-label="指派 Agent">
            <Flex vertical gap={4} className="task-board-native-assign-head" style={{ marginBottom: 12 }}>
              <strong>CLI / 团队兼容派发</strong>
              <small>员工请使用上方评论 @；此处保留旧工具和团队执行能力。</small>
            </Flex>
            <TaskTextArea
              className="resize-none task-board-detail-body"
              rows={5}
              value={composePrompt}
              placeholder={teams?.some((item) => item.id === teamId)
                ? "输入本轮交给团队的范围，确认时预览任务快照与主目标约束。"
                : employees.some((item) => item.id === employeeId)
                  ? "输入本轮交给员工的范围，确认时预览任务快照与主目标约束。"
                : "输入本轮执行范围，确认后随任务快照发送…"}
              aria-label="派发提示词"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                taskDispatchDrafts.set(task.id, value);
                setComposePrompt(value);
              }}
            />
            <Flex wrap gap="middle" className="task-board-native-editor-grid is-assign" style={{ marginTop: 12 }}>
              <AgentFields
                agent={agent}
                catalog={catalog}
                providerOptions={providerOptions}
                disabled={busy}
                ariaPrefix="任务"
                teams={teams}
                teamId={teamId}
                employees={[]}
                employeeId=""
                employeeOverride={false}
                onTeamChange={onTeamChange}
                onEmployeeChange={onEmployeeChange}
                onChange={onAgentChange}
              />
            </Flex>
            <div className="task-board-native-editor-actions">
              {task.sessions.length > 0 ? <WandButton kind="ghost" size="small" disabled={busy} onClick={() => setComposeOpen(false)}>取消</WandButton> : null}
              <WandButton
                kind="primary"
                size="small"
                className="task-board-native-dispatch"
                disabled={busy || !composePrompt.trim() || !!employeeId && !employees.some(item => item.id === employeeId && !item.archivedAt) || !!teamId && !teams?.some(item => item.id === teamId)}
                onClick={() => onDispatch(composePrompt)}
              >
                <WandIcon name="spark" size={14}/>
                {busy ? "正在派发…" : teams?.some((team) => team.id === teamId) ? "交给团队" : employeeId ? "交给员工" : "派发 CLI"}
              </WandButton>
            </div>
          </Card> : <WandButton kind="ghost"
            type="button"
            className="task-board-agent-add"
            aria-label="CLI / 团队兼容派发"
            disabled={busy}
            onClick={() => {
              onEmployeeChange("");
              setComposePrompt("");
              setComposeOpen(true);
            }}
          >
            <WandIcon name="plus" size={16}/>CLI / 团队兼容派发
          </WandButton>}
          <TaskTeamRunPanel taskId={task.id} refreshKey={teamRunRefresh} onOpenSession={onOpenSession}/>
        </Flex>
        <Card size="small" title="属性" className="task-board-detail-properties" aria-label="属性" style={{ flex: "1 1 260px", minWidth: 0 }}>
          <Form component={false} layout="vertical">
          <IssueField label="状态">
            <WandSelect
              value={task.status}
              options={[...ISSUE_COLUMNS, ISSUE_ARCHIVE_COLUMN].map((column) => ({ value: column.status, label: column.label }))}
              ariaLabel="任务状态"
              className="task-board-native-select"
              disabled={busy}
              onValueChange={(status) => onPatch({ status: status as WandTaskStatus })}
            />
          </IssueField>
          <IssueField label="优先级">
            <WandSelect
              value={task.priority}
              options={ISSUE_PRIORITIES.map((entry) => ({ value: entry.value, label: entry.label }))}
              ariaLabel="任务优先级"
              className="task-board-native-select"
              disabled={busy}
              onValueChange={(priority) => onPatch({ priority: priority as WandTaskPriority })}
            />
          </IssueField>
          <IssueField label="项目目录">
            <WandSelect
              value={issueWorkspaceSelectValue(task.workspaceId)}
              options={workspaceSelectOptions}
              ariaLabel="任务项目"
              placeholder="选择项目目录"
              searchable
              searchPlaceholder="搜索项目"
              className="task-board-native-select"
              disabled={busy}
              onValueChange={(value) => {
                const workspaceId = issueWorkspaceIdFromSelect(value);
                onPatch({ workspaceId, ...(task.parentTaskId && task.workspaceId !== workspaceId ? { parentTaskId: null } : {}) });
              }}
            />
          </IssueField>
          <IssueField label="归属父任务">
            <WandSelect
              value={task.parentTaskId || ISSUE_NO_PARENT}
              options={parentOptions}
              ariaLabel="归属父任务"
              placeholder="归属父任务"
              searchable
              searchPlaceholder="搜索主任务编号或标题"
              className="task-board-native-select task-board-parent-select"
              disabled={busy}
              onValueChange={(value) => onPatch({ parentTaskId: value === ISSUE_NO_PARENT ? null : value })}
            />
          </IssueField>
          <IssueField label="里程碑">
            <MilestonePicker
              value={task.milestoneId}
              workspaceId={task.workspaceId}
              disabled={busy}
              onChange={(milestoneId) => onPatch({ milestoneId })}
            />
          </IssueField>
          <IssueField label="截止日期">
            <TaskDatePicker
              ariaLabel="任务截止日期"
              className="task-board-detail-date"
              value={task.dueDate ?? ""}
              disabled={busy}
              onValueChange={(value) => onPatch({ dueDate: value || null })}
            />
          </IssueField>
          <IssueField label="标签">
            <WandInput
              type="text"
              className="task-board-detail-date"
              value={labelDraft}
              placeholder="用逗号分隔"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setLabelDraft(value);
              }}
              onBlur={() => {
                const labels = labelDraft.split(/[,，]/).map((label) => label.trim()).filter(Boolean);
                if (labels.join("\0") === task.labels.join("\0")) return;
                onPatch({ labels });
              }}
            />
            {knownLabels.length > 0 && <div className="task-board-card-meta">
              {task.labels.map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
            </div>}
          </IssueField>
          <div className="task-board-native-editor-actions">
            {canArchiveBoardTask(task) && <WandButton size="small" className="task-board-native-remove" disabled={busy} onClick={onRemove}>归档</WandButton>}
          </div>
          </Form>
        </Card>
      </Flex>
    </div>
  </Flex>;
}
