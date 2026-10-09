import "./library-layout";
import { TaskForm, TaskTextArea, TaskDatePicker } from "./form-controls";
import { WandInput } from "../ui";
import * as React from "react";
import { Alert, Card, Flex, Form, Typography } from "antd";
import { subscribeWandModelCatalog } from "../model-catalog";
import { subscribeTaskChanges } from "../task-changes";
import { draggedTaskId, isTaskDrag, startTaskDrag, TASK_DRAG_TYPE } from "./task-drag";
import { draggedSessionId, isSessionDrag, startSessionDrag } from "../workspaces/session-drag";
import { SessionMoveButton } from "../workspaces/session-move-button";
import { workspacesStore } from "../workspaces/controller";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { DEFAULT_WAND_TASK_PRIORITY, type TaskExecutionSubject, type WandTaskAgent, type WandTaskPriority, type WandTaskStatus } from "../../../task-types";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import {
  WandBreadcrumb,
  WandButton,
  WandDialogSurface,
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
import { useDefaultMilestone, usePreselectMilestone } from "../milestones/default-iteration";
import {
  collectIssueLabels,
  createDefaultIssueAgent,
  DEFAULT_ISSUE_BOARD_DISPLAY,
  EMPTY_ISSUE_FILTERS,
  filterIssues,
  issueBoardEmptyState,
  groupIssuesByStatus,
  issueAgentEffortOptions,
  ISSUE_AGENT_TARGETS,
  ISSUE_ARCHIVE_COLUMN,
  ISSUE_NO_PARENT,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  ISSUE_PRIORITIES,
  issueArchiveFolderOpen,
  issueCreateDispatches,
  issueDropDispatches,
  issueDropDispatchPrompt,
  isDispatchableIssueAgent,
  issueAgentModeOptions,
  issueAgentModelOptions,
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
  issueAgentTargetValue,
  withIssueAgentTarget,
  writeIssueBoardDisplay,
  type IssueAgentProvider,
  type IssueBoardDisplay,
  type IssueBoardFilters,
  type IssueBoardView,
  type IssueGanttZoom,
  type IssueModelCatalog,
} from "./task-board-agent";
import { AgentField, AgentFields, DISPATCH_VALUE, agentTargetIsDispatch, agentTargetOptions, agentTargetTeamId, agentTargetEmployeeId } from "./agent-fields";
import { TeamDispatchActionButton, TeamDispatchRoster, dispatchStartBlockedReason, useTeamDispatchFlow } from "../team-dispatch/roster";
import { aiTeamsRepository, type AiTeam } from "../ai-teams/repository";
import { TaskTeamRunPanel } from "../ai-teams/lazy";
import { taskBoardController, taskBoardStore } from "./task-board-controller";
import { taskBoardRepository, type IssueWorkspace, type WandTaskListed } from "./task-board-repository";
import {
  TaskBoardAgentChips,
  TaskBoardAgentSessionList,
  TaskBoardArchiveFolder,
  TaskBoardCardDetail,
  TaskBoardContextMenu,
  TaskBoardConversationButton,
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
import { confirmDiscardTaskDraft } from "../task-draft-guard";
import { readTaskBoardViewState, writeTaskBoardViewState, sortTaskBoardTasks, TASK_BOARD_SORTS, type TaskBoardSort } from "./task-board-view-state";
import { createGeneratedTitlePoller, type GeneratedTitlePoller } from "./generated-title-poll";

interface DraftState {
  workspaceId: string;
  title: string;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  dueDate: string;
  labels: string;
  /** 里程碑 id；空串表示不选。 */
  milestoneId: string;
  parentTaskId: string;
  agent: WandTaskAgent;
}

function emptyDraft(
  workspaceId: string,
  status: WandTaskStatus = "todo",
  agent: WandTaskAgent = createDefaultIssueAgent(),
  parentTaskId = "",
): DraftState {
  // 用户没挑优先级就默认「低」，不再落成「无优先级」。
  return { workspaceId, title: "", description: "", status, priority: DEFAULT_WAND_TASK_PRIORITY, dueDate: "", labels: "", milestoneId: "", parentTaskId, agent };
}

function agentOf(task: WandTaskListed, lastAgent?: WandTaskAgent | null): WandTaskAgent {
  return resolveIssueAgent(task.agent, lastAgent);
}

function columnOf(status: WandTaskStatus) {
  return ISSUE_COLUMNS.find((column) => column.status === status) ?? ISSUE_COLUMNS[0]!;
}

const IssueField = AgentField;

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
  const [restored] = React.useState(readTaskBoardViewState);
  const [tasks, setTasks] = React.useState<WandTaskListed[]>([]);
  const [workspaces, setWorkspaces] = React.useState<IssueWorkspace[]>([]);
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busyId, setBusyId] = React.useState("");
  const [sessionDropTarget, setSessionDropTarget] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [query, setQuery] = React.useState(restored.query);
  const [view, setView] = React.useState<IssueBoardView>(restored.view);
  const [sort, setSort] = React.useState<TaskBoardSort>(restored.sort);
  const [display, setDisplay] = React.useState<IssueBoardDisplay>(DEFAULT_ISSUE_BOARD_DISPLAY);
  const [filters, setFilters] = React.useState<IssueBoardFilters>(restored.filters);
  const [ganttZoom, setGanttZoom] = React.useState<IssueGanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = React.useState(false);
  const [filterWorkspaceId, setFilterWorkspaceId] = React.useState(restored.workspaceId);
  const mutationPending = React.useRef(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rememberCreateDefaults, setRememberCreateDefaults] = React.useState(false);
  const [createMore, setCreateMore] = React.useState(false);
  const [createExpanded, setCreateExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftState>(() => emptyDraft(""));
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const [selectedId, setSelectedId] = React.useState("");
  // 看板卡片的就地展开态，同一时刻只开一张；完整详情仍由 selectedId 那套详情页承担。
  const [expandedTaskId, setExpandedTaskId] = React.useState("");
  // 非点击收起（换视图、改筛选、Esc）后，把焦点还给那张卡片的触发按钮，和列表行共用一份实现。
  const bindCardTrigger = useExpansionFocusReturn(expandedTaskId);
  const [detailAgent, setDetailAgent] = React.useState<WandTaskAgent | null>(null);
  // 团队与 CLI 在同一个下拉里：选中团队时记下团队 id，派发改成交给团队。
  const [teams, setTeams] = React.useState<AiTeam[] | null>(null);
  const { employees } = useSiliconEmployees();
  const [teamTarget, setTeamTarget] = React.useState("");
  const [employeeTarget, setEmployeeTarget] = React.useState("");
  const [teamRunRefresh, setTeamRunRefresh] = React.useState(0);
  const [lastAgent, setLastAgent] = React.useState<WandTaskAgent>(() => createDefaultIssueAgent());
  const lastAgentRef = React.useRef(lastAgent);
  lastAgentRef.current = lastAgent;
  const [collapsedList, setCollapsedList] = React.useState<Record<WandTaskStatus, boolean>>({
    todo: false,
    doing: false,
    done: false,
    archived: true,
  });
  const [draggedId, setDraggedId] = React.useState("");
  const [dropStatus, setDropStatus] = React.useState<WandTaskStatus | "">("");
  const [archiveDrop, setArchiveDrop] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState<{ taskId: string; x: number; y: number } | null>(null);
  const [composeRequest, setComposeRequest] = React.useState<{ id: string; nonce: number } | null>(null);
  const loadGenerationRef = React.useRef(0);
  const workspaceGenerationRef = React.useRef(0);
  const titleRef = React.useRef<HTMLTextAreaElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const columnScrollRefs = React.useRef<Partial<Record<WandTaskStatus, HTMLElement>>>({});
  const titlePollerRef = React.useRef<GeneratedTitlePoller | null>(null);

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
        setFilterWorkspaceId((current) => next.some((workspace) => workspace.id === current) ? current : "");
      }
    } catch {
      // 轮询失败时保留上一次成功列表，避免瞬时错误把已选目录清掉。
    }
  }, []);

  // 看板关闭时停掉自动标题轮询：轮询每轮都会 reload + setState，用户看不见时不该继续跑。
  React.useEffect(() => {
    if (controller.open) return;
    titlePollerRef.current?.cancel();
  }, [controller.open]);

  // 组件整体卸载（登出 / 切到旧外壳）时兜底取消。
  React.useEffect(() => () => { titlePollerRef.current?.cancel(); }, []);

  React.useEffect(() => {
    if (!controller.open) return;
    setDisplay(readIssueBoardDisplay());
    void reload();
    void loadWorkspaces();
    void taskBoardRepository.models()
      .then((payload) => setCatalog(normalizeIssueModelCatalog(payload)))
      .catch(() => setCatalog(null));
    void aiTeamsRepository.list().then(setTeams).catch(() => setTeams([]));
    void taskBoardRepository.agentDefaults()
      .then((next) => {
        lastAgentRef.current = next;
        setLastAgent(next);
      })
      .catch(() => undefined);
    return subscribeWandModelCatalog(setCatalog);
  }, [controller.open, controller.revision, loadWorkspaces, reload]);

  React.useEffect(() => {
    if (!controller.open) return;
    // 新建对话框打开时用更高频率同步目录；仅看板打开时维持普通轮询。
    const interval = window.setInterval(() => { void loadWorkspaces(); void reload(true); }, createOpen ? 2_000 : 6_000);
    const unsubscribe = subscribeTaskChanges(() => { void reload(true); void loadWorkspaces(); });
    return () => { window.clearInterval(interval); unsubscribe(); };
  }, [controller.open, createOpen, loadWorkspaces, reload]);

  React.useEffect(() => {
    setError("");
    setNotice("");
    setSelectedId("");
    setDetailAgent(null);
    setCreateOpen(false);
    setContextMenu(null);
  }, [controller.revision, controller.open]);

  React.useEffect(() => {
    if (!controller.workspaceId) return;
    setFilterWorkspaceId((current) => current || controller.workspaceId);
    setDraft((current) => (current.workspaceId ? current : { ...current, workspaceId: controller.workspaceId }));
  }, [controller.workspaceId, controller.open]);

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

  const rememberAgent = React.useCallback((agent: WandTaskAgent) => {
    if (!isDispatchableIssueAgent(agent)) return;
    lastAgentRef.current = agent;
    setLastAgent(agent);
  }, []);

  // 新卡片默认挂到「默认迭代」：用户不选也有归属，面板上直接看得见。
  const presetMilestone = useDefaultMilestone(draft.workspaceId || filterWorkspaceId || null, createOpen);
  usePreselectMilestone(createOpen, presetMilestone, (id) => {
    setDraft((current) => (current.milestoneId ? current : { ...current, milestoneId: id }));
  });

  const openCreate = React.useCallback((status: WandTaskStatus = "todo", parent?: WandTaskListed) => {
    setTeamTarget("");
    setEmployeeTarget("");
    setDraft({
      ...emptyDraft(parent ? parent.workspaceId ?? "" : filterWorkspaceId || controller.workspaceId, status, lastAgentRef.current, parent?.id),
      milestoneId: parent?.milestoneId ?? "",
    });
    setCreateExpanded(false);
    setRememberCreateDefaults(false);
    setCreateOpen(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [controller.workspaceId, filterWorkspaceId]);

  const createTask = React.useCallback(async (): Promise<void> => {
    const submitTitle = draft.title.trim();
    const submitDescription = draft.description.trim();
    // 标题是可选字段：只写描述也能创建，标题由服务端按描述自动生成。
    if ((!submitTitle && !submitDescription) || loading) return;
    await runFor("__create__", async () => {
      const subject: TaskExecutionSubject = teamTarget && issueCreateDispatches(draft.status)
        ? { type: "team", id: teamTarget }
        : employeeTarget && issueCreateDispatches(draft.status)
          ? { type: "employee", id: employeeTarget }
          : { type: "cli", id: draft.agent.provider };
      const created = await taskBoardRepository.create({
        workspaceId: draft.workspaceId || null,
        title: submitTitle,
        description: submitDescription,
        status: draft.status,
        priority: draft.priority,
        labels: draft.labels.split(/[,，]/).map((label) => label.trim()).filter(Boolean),
        dueDate: draft.dueDate || null,
        milestoneId: draft.milestoneId || null,
        parentTaskId: draft.parentTaskId || null,
        ...(subject.type === "cli" ? { agent: draft.agent } : {}),
        executionSubject: subject,
        rememberAgentDefaults: subject.type === "cli" && rememberCreateDefaults,
      });
      if (subject.type === "cli" && rememberCreateDefaults) rememberAgent(draft.agent);
      // 只有「处理中」列的新建才顺带第一次指派；「等待认领」列只创建任务。
      // 有描述才派发，否则只落库，之后在任务详情里再指派。
      let assignError = "";
      const team = subject.type === "team" ? teams?.find((item) => item.id === subject.id) : undefined;
      const employee = subject.type === "employee" ? employees.find((item) => item.id === subject.id) : undefined;
      if (team && submitDescription) {
        try {
          await taskBoardRepository.dispatch(created.id, null, {
            subject, prompt: submitDescription, workspaceId: draft.workspaceId || null,
          });
          setNotice(`团队「${team.name}」已开始处理「${created.title}」`);
        } catch (cause) {
          assignError = cause instanceof Error ? cause.message : "任务已创建，但交给团队失败。";
        }
      } else if (issueCreateDispatches(draft.status) && submitDescription && (employee || isDispatchableIssueAgent(draft.agent))) {
        try {
          const result = await taskBoardRepository.dispatch(created.id, subject.type === "cli" ? draft.agent : null, {
            prompt: submitDescription,
            workspaceId: draft.workspaceId || null,
            subject,
          });
          setNotice(`${employee?.name || issueAgentLabel(result.session?.provider || draft.agent.provider, draft.agent.engine)} 已开始处理「${created.title}」`);
        } catch (cause) {
          assignError = cause instanceof Error ? cause.message : "任务已创建，但第一次指派失败。";
        }
      }
      if (draftRef.current !== draft) {
        // Keep edits made after this submission; the accepted task still refreshes below.
        requestAnimationFrame(() => titleRef.current?.focus());
      } else if (createMore) {
        setDraft({ ...emptyDraft(draft.workspaceId, draft.status, draft.agent, draft.parentTaskId), milestoneId: draft.milestoneId });
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        setCreateOpen(false);
        setDraft(emptyDraft(draft.workspaceId, "todo", draft.agent));
      }
      await reload();
      // reload() 开头会清掉错误横幅，所以这些提示必须放在它之后才留得住。
      if (assignError) setError(assignError);
      else setNotice(`已创建任务「${created.title}」${issueCreateDispatches(draft.status) && submitDescription ? "，工具已启动" : "，未启动执行"}${subject.type === "cli" && rememberCreateDefaults ? "；以后新建任务将使用这组执行默认" : ""}。`);
      if (!submitTitle && created.titleSource === "auto") {
        titlePollerRef.current ??= createGeneratedTitlePoller({
          getTask: (taskId) => taskBoardRepository.get(taskId),
          reload,
        });
        void titlePollerRef.current.start(created.id, created.title);
      }
    });
  }, [createMore, draft, employeeTarget, employees, loading, rememberAgent, rememberCreateDefaults, reload, runFor, teamTarget, teams]);

  const patchTask = React.useCallback(async (id: string, patch: Parameters<typeof taskBoardRepository.update>[1]) => {
    await runFor(id, async () => {
      await taskBoardRepository.update(id, patch);
      await reload();
    });
  }, [reload, runFor]);

  const removeTask = React.useCallback(async (task: WandTaskListed): Promise<void> => {
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
      setNotice(`${issueAgentLabel(result.session?.provider || agent.provider, agent.engine)} 已开始处理「${task.title}」`);
      await reload();
    });
  }, [reload, runFor]);

  // 交给团队：这次输入的提示词就是本轮任务。任务卡上的旧描述不再静默拼进去。
  const dispatchTeam = React.useCallback(async (task: WandTaskListed, team: AiTeam, prompt: string): Promise<void> => {
    await runFor(task.id, async () => {
      const note = prompt.trim();
      const result = await taskBoardRepository.dispatch(task.id, null, {
        prompt: note,
        workspaceId: task.workspaceId,
        subject: { type: "team", id: team.id },
      });
      setNotice(`团队「${team.name}」已开始处理「${task.title}」`);
      setTeamRunRefresh((value) => value + 1);
      await reload();
      // 团队的进展都在群聊里，派完直接带用户过去看。
      if (result.teamRun?.run.id) taskBoardController.open("", "", "teamchat", result.teamRun.run.id);
      else if (result.session?.id) onOpenSession?.(result.session.id);
    });
  }, [onOpenSession, reload, runFor]);

  const dispatchEmployee = React.useCallback(async (task: WandTaskListed, employeeId: string, prompt: string): Promise<void> => {
    const employee = employees.find((item) => item.id === employeeId);
    if (!employee) return;
    await runFor(task.id, async () => {
      const result = await taskBoardRepository.dispatch(task.id, null, {
        prompt: prompt.trim(),
        workspaceId: task.workspaceId,
        subject: { type: "employee", id: employeeId },
      });
      setNotice(`${employee.name} 已开始处理「${task.title}」`);
      await reload();
      if (result.session?.id) onOpenSession?.(result.session.id);
    });
  }, [employees, onOpenSession, reload, runFor]);

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
          setNotice(`${targetName || issueAgentLabel(result.session?.provider || agent.provider, agent.engine)} 已开始处理「${moving.title}」`);
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
    if (!moving || moving.status === "archived") return;
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
  const visible = sortTaskBoardTasks(filterIssues(tasks, query, filterWorkspaceId, filters, archiveOpen), sort);
  const grouped = groupIssuesByStatus(visible);
  const matchedTasks = filterIssues(tasks, query, filterWorkspaceId, filters, true);
  const activeCount = matchedTasks.filter((task) => task.status !== "archived").length;
  const archiveCount = matchedTasks.length - activeCount;
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
  const createParentOptions = issueParentOptions(tasks, draft.workspaceId || undefined, null, draft.parentTaskId);
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
  // 新建对话框与「处理中」列保持一致：只有会立刻指派时才展示指派控件。
  // 无指派派工：不指定员工/团队，由本机决策模型给建议名单后再确认开工。
  // 服务端自己建卡 + 建临时团队 + 起 run，所以这条路径不创建本地任务，也不派 CLI。
  const [dispatchSelected, setDispatchSelected] = React.useState(false);
  const dispatchFlow = useTeamDispatchFlow();
  const createDispatches = issueCreateDispatches(draft.status);
  const createTeam = createDispatches ? teams?.find((team) => team.id === teamTarget) ?? null : null;
  const createEmployee = createDispatches ? employees.find((employee) => employee.id === employeeTarget) ?? null : null;

  React.useEffect(() => {
    if (!selected) {
      setDetailAgent(null);
      return;
    }
    setDetailAgent(agentOf(selected, lastAgentRef.current));
    setTeamTarget(selected.executionSubject?.type === "team" ? selected.executionSubject.id : "");
    setEmployeeTarget(selected.executionSubject?.type === "employee" ? selected.executionSubject.id : "");
  }, [selected?.id, selected?.agent, selected?.executionSubject?.type, selected?.executionSubject?.id]);

  React.useEffect(() => {
    writeTaskBoardViewState({ view, query, workspaceId: filterWorkspaceId, filters, sort });
  }, [view, query, filterWorkspaceId, filters, sort]);

  // 展开态只属于「当前这一屏看板」：换视图、改筛选或搜索、进完整详情、重开面板时一律收起，
  // 不留半开（卡片可能已经不在这一列里了）。
  React.useEffect(() => {
    setExpandedTaskId("");
  }, [view, query, filterWorkspaceId, filters, selectedId, controller.open, controller.revision]);

  React.useEffect(() => {
    const previous = document.title;
    document.title = selected ? `${selected.title} · Wand` : "任务看板 · Wand";
    return () => { document.title = previous; };
  }, [selected?.title]);

  const closeCreate = React.useCallback(async (): Promise<void> => {
    if (mutationPending.current) return;
    if (draft.title.trim() || draft.description.trim()) {
      if (!await confirmDiscardTaskDraft()) return;
    }
    setCreateOpen(false);
  }, [draft.title, draft.description]);

  React.useEffect(() => {
    if (!controller.open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
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
        openCreate("todo");
        return;
      }
      if (event.key !== "Escape" || typing) return;
      if (createOpen) {
        void closeCreate();
        return;
      }
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
  }, [controller.open, createOpen, closeCreate, expandedTaskId, onBack, openCreate, selectedId]);

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
        onClick={() => setExpandedTaskId((current) => current === task.id ? "" : task.id)}
      ><Typography.Text strong id={`task-${task.id}-title`}>{task.title || "未命名任务"}</Typography.Text></WandButton>
      <WandIconButton className="task-board-card-menu" aria-label={`任务菜单 ${task.identifier}`} disabled={busy}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setContextMenu({ taskId: task.id, x: rect.left, y: rect.bottom }); }}>
        <WandIcon name="more" size={16}/>
      </WandIconButton>
      </Flex>
      {display.body && task.description && !expanded
        ? <p className="task-board-card-body">{task.description}</p>
        : null}
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
        <TaskBoardAgentChips sessions={task.sessions} assigned={assigned}/>
        {task.status !== "doing"
          ? <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
          : null}
      </Flex>
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
      <Flex vertical gap="small" className="task-board-column-list" ref={(node) => { columnScrollRefs.current[status] = node ?? undefined; }}>
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
        {!selected && <>
          <WandIconButton disabled={loading} onClick={() => void reload()} aria-label="刷新任务" title="刷新任务">
            <WandIcon name="refresh"/>
          </WandIconButton>
          <WandButton
            className="task-board-create-button"
            kind="primary"
            size="small"
            aria-label="新建任务"
            title="新建任务 (C)"
            onClick={() => openCreate("todo")}
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
        <WandSelect
          className="task-board-workspace-filter"
          value={filterWorkspaceId || "__all__"}
          options={[{ value: "__all__", label: "所有目录" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]}
          ariaLabel="筛选工作目录"
          searchable
          searchPlaceholder="搜索目录"
          onValueChange={(value) => setFilterWorkspaceId(value === "__all__" ? "" : value)}
        />
        <WandSearchField inputRef={searchRef} className="task-board-search" label="搜索任务" placeholder="搜索标题、编号或正文" value={query} onValueChange={setQuery}/>
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
      <span>{loading ? "正在同步任务…" : `活动 ${activeCount} · 归档 ${archiveCount}`}{(query || filterActive || filterWorkspaceId) ? " · 已筛选" : ""}</span>
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
      teamRunRefresh={teamRunRefresh}
      onTeamChange={setTeamTarget}
      onEmployeeChange={setEmployeeTarget}
      workspaceOptions={workspaceOptions}
      parent={tasks.find((task) => task.id === selected.parentTaskId) ?? null}
      children={selectedChildren}
      parentOptions={issueParentOptions(tasks, selected.workspaceId, selected.id, selected.parentTaskId)}
      onOpenTask={setSelectedId}
      onCreateChild={() => openCreate("doing", selected)}
      onAgentChange={(agent) => {
        setDetailAgent(agent);
      }}
      onPatch={(patch) => void patchTask(selected.id, patch)}
      composeRequest={composeRequest}
      onDispatch={(prompt) => {
        const team = teams?.find((item) => item.id === teamTarget);
        void (team ? dispatchTeam(selected, team, prompt)
          : employeeTarget ? dispatchEmployee(selected, employeeTarget, prompt)
            : dispatchTask(selected, detailAgentValue, prompt));
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
        } else openCreate("todo");
      }}>{emptyState.kind === "filtered" ? "清除筛选" : "新建任务"}</WandButton>
    </div> : view === "dashboard" ? <TaskBoardDashboard
      projectName={projectName}
      tasks={visible}
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
    /> : view === "gantt" ? <TaskBoardGantt
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

    <WandDialogSurface
      open={createOpen}
      title="新建任务"
      className={classNames("wand-ui-dialog-content", "wand-task-library-dialog task-board-create-library-dialog", createExpanded && "is-expanded")}
      description={createDispatches
        ? "描述要完成的工作，创建后交给所选工具执行。"
        : "先记录要做的事，准备好后再从任务详情启动执行。"}
      closeLabel="关闭新建任务"
      dismissable={busyId !== "__create__"}
      closeContent={<WandIcon name="close" size={14} strokeWidth={1.8}/>}
      onOpenChange={(open) => {
        if (!open) void closeCreate();
      }}
    >
      <TaskForm noValidate
        aria-busy={busyId === "__create__"}
        className="task-board-create-form task-board-native-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (dispatchSelected) {
            // 派工由服务端建卡 + 起 run：同一个按钮先选人、再确认开工。
            void (dispatchFlow.hasPlan
              ? dispatchFlow.startNow(draft.workspaceId, draft.description).then((started) => {
                if (started) {
                  setDispatchSelected(false);
                  dispatchFlow.resetResults();
                  closeCreate();
                  const chatId = started.run?.chatSessionId;
                  if (chatId) onOpenSession?.(chatId);
                  else setNotice(`已开工（任务 ${started.taskId}），可在任务详情里查看团队运行。`);
                }
              })
              : dispatchFlow.planNow(draft.description));
            return;
          }
          void createTask();
        }}
      >
        <Flex vertical gap="small" className="task-board-create-writing task-board-form-section">
          <h3 className="task-board-form-section-title">任务内容</h3>
          {/* 标题是可选字段：留空就按描述自动生成，所以这里刻意做得比描述框更轻。 */}
          <Form.Item label={<span id="task-board-create-title-label">任务标题 <Typography.Text type="secondary">可选</Typography.Text></span>} className="task-board-create-title-field">

            <TaskTextArea
              ref={titleRef}
              className="resize-none task-board-create-title-input"
              rows={1}
              value={draft.title}
              placeholder="不填写则按描述自动生成"
              aria-labelledby="task-board-create-title-label"
              maxLength={240}
              data-wand-autofocus=""
              onChange={(event) => {
                const value = event.currentTarget.value.replace(/\n/g, "");
                setDraft((current) => ({ ...current, title: value }));
              }}
            />
          </Form.Item>
          <IssueField label="任务描述"><TaskTextArea
            className="resize-none task-board-create-body-input"
            rows={4}
            value={draft.description}
            placeholder={createDispatches
              ? "添加描述…（将作为第一个 Agent 的指派内容）"
              : "添加描述…（只创建任务，不指派 Agent）"}
            aria-label={createDispatches ? "任务描述（作为第一次指派）" : "任务描述"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, description: value }));
            }}
          /></IssueField>
        </Flex>
        <Flex vertical gap="middle" className="task-board-create-meta">
          <section className="task-board-form-section">
          <h3 className="task-board-form-section-title">归属与排期</h3>
          <Flex wrap gap="small" className="task-board-create-properties" aria-label="任务属性">
            <IssueField label="项目目录"><WandSelect
              value={issueWorkspaceSelectValue(draft.workspaceId)}
              options={workspaceOptions}
              ariaLabel="指定项目目录"
              placeholder="选择项目目录"
              searchable
              searchPlaceholder="搜索项目"
              className="task-board-native-select"
              onValueChange={(value) => {
                const workspaceId = issueWorkspaceIdFromSelect(value) ?? "";
                setDraft((current) => ({
                  ...current,
                  workspaceId,
                  parentTaskId: tasks.some((task) => task.id === current.parentTaskId && task.workspaceId === (workspaceId || null))
                    ? current.parentTaskId : "",
                }));
              }}
            /></IssueField>
            <IssueField label="父任务"><WandSelect
              value={draft.parentTaskId || ISSUE_NO_PARENT}
              options={createParentOptions}
              ariaLabel="归属父任务"
              placeholder="归属父任务"
              searchable
              searchPlaceholder="搜索正在处理的任务"
              className="task-board-native-select task-board-parent-select"
              onValueChange={(value) => {
                const parent = tasks.find((task) => task.id === value);
                setDraft((current) => ({
                  ...current,
                  parentTaskId: parent?.id ?? "",
                  workspaceId: parent ? parent.workspaceId ?? "" : current.workspaceId,
                  milestoneId: parent?.milestoneId ?? current.milestoneId,
                }));
              }}
            /></IssueField>
            <IssueField label="任务状态"><WandSelect
              value={draft.status}
              options={ISSUE_COLUMNS.map((column) => ({ value: column.status, label: column.label }))}
              ariaLabel="状态"
              className="task-board-native-select"
              onValueChange={(status) => setDraft((current) => ({ ...current, status: status as WandTaskStatus }))}
            /></IssueField>
            <IssueField label="优先级"><WandSelect
              value={draft.priority}
              options={ISSUE_PRIORITIES.map((entry) => ({ value: entry.value, label: entry.label }))}
              ariaLabel="优先级"
              className="task-board-native-select"
              onValueChange={(priority) => setDraft((current) => ({ ...current, priority: priority as WandTaskPriority }))}
            /></IssueField>
            <IssueField label="截止日期">
              <TaskDatePicker
                ariaLabel="截止日期"
                value={draft.dueDate}
                popupOwner="task-board-create"
                onValueChange={(dueDate) => setDraft((current) => ({ ...current, dueDate }))}
              />
            </IssueField>
            <IssueField label="迭代"><MilestonePicker
              value={draft.milestoneId || null}
              workspaceId={draft.workspaceId || null}
              onChange={(milestoneId) => setDraft((current) => ({ ...current, milestoneId: milestoneId ?? "" }))}
            /></IssueField>
            <IssueField label="标签">
              <WandInput
                type="text"
                value={draft.labels}
                placeholder="用逗号分隔"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((current) => ({ ...current, labels: value }));
                }}
              />
            </IssueField>
          </Flex>
          </section>

          {/* 执行配置先属于本任务；只有显式勾选后才在创建成功时更新以后默认。 */}
          <Card size="small" className="task-board-create-assign task-board-form-section" aria-label={createDispatches ? "第一次指派" : "Agent 与运行模式"}>
            <Flex vertical gap={4} className="task-board-create-assign-copy" style={{ marginBottom: 12 }}>
              <strong>{createDispatches ? "第一次指派" : "Agent 与运行模式"}</strong>
              <span>{dispatchSelected
                ? "不指派员工：本机决策模型给建议名单，确认后才开工"
                : createTeam ? "有描述时会立刻交给团队，由负责人拆解分派"
                : createEmployee ? "有描述时会立刻交给员工"
                : createDispatches ? "有描述时会立即交给所选工具；配置仅用于本任务" : "只创建任务，不指派 Agent；执行配置保存在本任务中"}</span>
            </Flex>
            <Flex wrap gap="small" className="task-board-create-assign-controls">
              {providerOptions ? <IssueField label="执行对象"><WandSelect
                value={dispatchSelected ? DISPATCH_VALUE
                  : createEmployee ? `employee:${createEmployee.id}`
                  : createTeam ? `team:${createTeam.id}` : issueAgentTargetValue(draft.agent)}
                options={createDispatches
                  ? agentTargetOptions(providerOptions, teams, employees, { includeDispatch: true })
                  : providerOptions}
                ariaLabel="任务执行对象"
                className="task-board-native-select"
                onValueChange={(value) => {
                  if (agentTargetIsDispatch(value)) {
                    setTeamTarget("");
                    setEmployeeTarget("");
                    dispatchFlow.resetResults();
                    setDispatchSelected(true);
                    setDraft((current) => ({ ...current, agent: { ...current.agent, kind: "structured" } }));
                    return;
                  }
                  setDispatchSelected(false);
                  dispatchFlow.resetResults();
                  const nextTeam = agentTargetTeamId(value);
                  const nextEmployee = agentTargetEmployeeId(value);
                  setTeamTarget(nextTeam);
                  setEmployeeTarget(nextEmployee);
                  if (nextTeam || nextEmployee) {
                    setDraft((current) => ({ ...current, agent: { ...current.agent, kind: "structured" } }));
                    return;
                  }
                  setDraft((current) => ({
                    ...current,
                    agent: withIssueAgentTarget(current.agent, value, catalog),
                  }));
                }}
              /></IssueField> : <span role="status">正在加载工具列表…</span>}
              {createTeam || createEmployee || dispatchSelected ? null : <>
              <IssueField label="模型"><WandSelect
                value={draft.agent.model}
                options={issueAgentModelOptions(catalog, draft.agent.provider)}
                ariaLabel="任务执行模型"
                searchable
                searchPlaceholder="搜索模型"
                className="task-board-native-select"
                onValueChange={(model) => setDraft((current) => ({ ...current, agent: { ...current.agent, model } }))}
              /></IssueField>
              <IssueField label="思考深度"><WandSelect
                value={draft.agent.thinkingEffort}
                options={issueAgentEffortOptions(draft.agent.provider, catalog, draft.agent.model, draft.agent.thinkingEffort)}
                ariaLabel="任务思考深度"
                className="task-board-native-select"
                onValueChange={(effort) => setDraft((current) => ({
                  ...current,
                  agent: { ...current.agent, thinkingEffort: effort as WandTaskAgent["thinkingEffort"] },
                }))}
              /></IssueField>
              <IssueField label="运行模式"><WandSelect
                value={draft.agent.mode}
                options={issueAgentModeOptions(draft.agent.provider)}
                ariaLabel="运行模式"
                className="task-board-native-select"
                onValueChange={(mode) => {
                  setDraft((current) => ({ ...current, agent: { ...current.agent, mode: mode as WandTaskAgent["mode"] } }));
                }}
              /></IssueField>
              </>}
            </Flex>
            {!createTeam && !createEmployee && !dispatchSelected && draft.agent.mode === "full-access" && <Alert type="warning" showIcon
              className="task-board-create-permission-note" title="完全访问（Full access）"
              description="工具会自动确认权限请求。创建前请确认执行对象和项目目录。"/>}
            {!createTeam && !createEmployee && !dispatchSelected && <div className="task-board-defaults-choice">
              <WandSwitch checked={rememberCreateDefaults} onCheckedChange={setRememberCreateDefaults}
                ariaLabel="同时设为以后默认" label="同时设为以后默认" disabled={busyId === "__create__"}/>
              <Typography.Text type="secondary">创建成功后生效；不改变已有任务或会话。</Typography.Text>
            </div>}
            {dispatchSelected ? <div className="task-board-create-dispatch">
              <TeamDispatchRoster
                flow={dispatchFlow}
                blockedReason={dispatchStartBlockedReason({
                  selection: dispatchFlow.selection,
                  workspaceId: draft.workspaceId,
                  note: draft.description,
                  busy: dispatchFlow.busy,
                })}
              />
            </div> : null}
          </Card>
        </Flex>
        {error && <Alert type="error" role="alert" showIcon title={error}/>}
        <Flex wrap gap="small" align="center" justify="space-between" className="task-board-create-footer" style={{ marginTop: 16 }}>
          <WandSwitch
            checked={createMore}
            onCheckedChange={setCreateMore}
            ariaLabel="创建更多"
            label="创建更多"
          />
          <WandIconButton
            className="task-board-icon-button"
            aria-label={createExpanded ? "收起编辑器" : "展开编辑器"}
            onClick={() => setCreateExpanded((open) => !open)}
          >
            <WandIcon name={createExpanded ? "chevron" : "up"}/>
          </WandIconButton>
          {dispatchSelected ? <div className="task-board-create-submit-slot">
            <TeamDispatchActionButton
              flow={dispatchFlow}
              canPlan={draft.description.trim().length > 0}
              blockedReason={dispatchStartBlockedReason({
                selection: dispatchFlow.selection,
                workspaceId: draft.workspaceId,
                note: draft.description,
                busy: dispatchFlow.busy,
              })}
            />
          </div> : <WandButton
            kind="primary"
            type="submit"
            className="task-board-create-submit"
            disabled={(!draft.title.trim() && !draft.description.trim()) || busyId === "__create__"}
          >
            {busyId === "__create__" ? "正在保存…" : createDispatches && draft.description.trim() ? "创建并指派" : "创建任务"}
          </WandButton>}
        </Flex>
      </TaskForm>
    </WandDialogSurface>
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
  teamRunRefresh: number;
  onTeamChange(teamId: string): void;
  onEmployeeChange(employeeId: string): void;
  workspaceOptions: ReturnType<typeof issueWorkspaceOptions>;
  parent: WandTaskListed | null;
  children: WandTaskListed[];
  parentOptions: ReturnType<typeof issueParentOptions>;
  onOpenTask(id: string): void;
  onCreateChild(): void;
  onAgentChange(agent: WandTaskAgent): void;
  onPatch(patch: Parameters<typeof taskBoardRepository.update>[1]): void;
  onDispatch(prompt: string): void;
  onRemove(): void;
  onOpenSession?: (sessionId: string) => void;
  composeRequest: { id: string; nonce: number } | null;
}): React.ReactElement {
  const [title, setTitle] = React.useState(task.title);
  const [labelDraft, setLabelDraft] = React.useState(task.labels.join(", "));
  const hasAgents = task.sessions.length > 0;
  const [composeOpen, setComposeOpen] = React.useState(!hasAgents);
  const [composePrompt, setComposePrompt] = React.useState("");
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
    const assigned = sessionCount > 0;
    setComposeOpen(!assigned);
    setComposePrompt("");
  }, [task.id, sessionCount]);

  React.useEffect(() => {
    if (composeRequest?.id !== task.id) return;
    setComposeOpen(true);
    setComposePrompt("");
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
            rows={1}
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
          <TaskBoardAgentSessionList
            sessions={task.sessions}
            assigned={task.agent}
            catalog={catalog}
            onOpenSession={onOpenSession}
          />
          {(children.length > 0 || task.status === "doing") && <section className="task-board-children" aria-label="子任务">
            <div className="task-board-children-head">
              <strong>子任务 <span>{children.length}</span></strong>
              {task.status === "doing" && <WandButton kind="ghost" size="small" onClick={onCreateChild}>
                <WandIcon name="plus" size={14} slot="start"/>派发子任务
              </WandButton>}
            </div>
            {children.map((child) => <WandButton kind="ghost" key={child.id} type="button" className="task-board-child-row" onClick={() => onOpenTask(child.id)}>
              <TaskBoardStatusGlyph status={child.status}/>
              <span>{child.title}</span>
              <small>{child.identifier}</small>
            </WandButton>)}
          </section>}
          {composeOpen ? <Card size="small" className="task-board-native-assign" aria-label="指派 Agent">
            <Flex vertical gap={4} className="task-board-native-assign-head" style={{ marginBottom: 12 }}>
              <strong>{task.sessions.length > 0 ? "再指派一个 Agent" : "指派 Agent"}</strong>
              <small>先输入提示词，再选员工、团队或 CLI</small>
            </Flex>
            <TaskTextArea
              className="resize-none task-board-detail-body"
              rows={5}
              value={composePrompt}
              placeholder={teams?.some((item) => item.id === teamId)
                ? "输入这次交给团队的提示词。任务卡里的旧描述不会自动带上。"
                : employees.some((item) => item.id === employeeId)
                  ? "输入这次交给员工的任务。任务卡里的旧描述不会自动带上。"
                : "输入这次派给 Agent 的提示词…"}
              aria-label="派发提示词"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
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
                employees={employees}
                employeeId={employeeId}
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
                disabled={busy || !composePrompt.trim()}
                onClick={() => onDispatch(composePrompt)}
              >
                <WandIcon name="spark" size={14}/>
                {busy ? "正在派发…" : teams?.some((team) => team.id === teamId) ? "交给团队" : employeeId ? "交给员工" : "派发 CLI"}
              </WandButton>
            </div>
          </Card> : <WandButton kind="ghost"
            type="button"
            className="task-board-agent-add"
            aria-label="再指派一个 Agent"
            disabled={busy}
            onClick={() => {
              setComposePrompt("");
              setComposeOpen(true);
            }}
          >
            <WandIcon name="plus" size={16}/>
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
              searchPlaceholder="搜索正在处理的任务"
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
            <WandButton kind="danger" size="small" className="task-board-native-remove" disabled={busy} onClick={onRemove}>归档</WandButton>
          </div>
          </Form>
        </Card>
      </Flex>
    </div>
  </Flex>;
}
