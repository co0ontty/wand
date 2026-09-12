import * as React from "react";
import type { WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types";
import {
  WandButton,
  WandDialogSurface,
  WandIcon,
  WandSelect,
  WandSkeleton,
  WandSwitch,
} from "../ui";
import { classNames } from "../ui/class-names";
import {
  collectIssueLabels,
  createDefaultIssueAgent,
  DEFAULT_ISSUE_BOARD_DISPLAY,
  dropIndexFromPoint,
  EMPTY_ISSUE_FILTERS,
  filterIssues,
  groupIssuesByStatus,
  ISSUE_AGENT_EFFORTS,
  ISSUE_AGENT_PROVIDERS,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  ISSUE_PRIORITIES,
  isDispatchableIssueAgent,
  issueAgentModelOptions,
  issueAgentProviderLabel,
  issueDueStamp,
  issueFilterCount,
  issueIsOverdue,
  issueWorkspaceIdFromSelect,
  issueWorkspaceOptions,
  issueWorkspaceSelectValue,
  normalizeIssueModelCatalog,
  readIssueBoardDisplay,
  reorderIssues,
  resolveIssueAgent,
  sortIssues,
  withIssueAgentProvider,
  writeIssueBoardDisplay,
  type IssueBoardDisplay,
  type IssueBoardFilters,
  type IssueBoardView,
  type IssueGanttZoom,
  type IssueModelCatalog,
} from "./task-board-agent";
import { taskBoardController, taskBoardStore } from "./task-board-controller";
import { taskBoardRepository, type IssueWorkspace, type WandTaskListed } from "./task-board-repository";
import {
  TaskBoardAgentChips,
  TaskBoardAgentSessionList,
  TaskBoardCompleteButton,
  TaskBoardContextMenu,
  TaskBoardConversationButton,
  TaskBoardDashboard,
  TaskBoardDisplayMenu,
  TaskBoardFilterMenu,
  TaskBoardGantt,
  TaskBoardLabelChip,
  TaskBoardListView,
  TaskBoardPriorityChip,
  TaskBoardProcessingRow,
  TaskBoardProgressRow,
  TaskBoardProjectChip,
  TaskBoardStatusGlyph,
} from "./task-board-views";
import { TaskBoardSearchIcon } from "./task-board-icons";

const TASK_MIME = "application/x-wand-task";

interface DraftState {
  workspaceId: string;
  title: string;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
  dueDate: string;
  labels: string;
  agent: WandTaskAgent;
}

function emptyDraft(workspaceId: string, status: WandTaskStatus = "todo", agent: WandTaskAgent = createDefaultIssueAgent()): DraftState {
  return { workspaceId, title: "", description: "", status, priority: "none", dueDate: "", labels: "", agent };
}

// 自动生成标题是后台完成的，创建响应里只有描述首行占位；这里短轮询几次，拿到模型标题就刷新。
const AUTO_TITLE_POLL_DELAYS_MS = [1_200, 2_000, 3_000, 5_000, 8_000];

async function refreshGeneratedTitle(taskId: string, placeholder: string, reload: () => Promise<void>): Promise<void> {
  for (const delay of AUTO_TITLE_POLL_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await reload();
    const task = await taskBoardRepository.get(taskId).catch(() => null);
    // 标题还是占位值说明后台还没总结完（或总结失败），继续等到下一次轮询。
    if (task && task.title && task.title !== placeholder) return;
  }
}

function agentOf(task: WandTaskListed, lastAgent?: WandTaskAgent | null): WandTaskAgent {
  return resolveIssueAgent(task.agent, lastAgent);
}

function columnOf(status: WandTaskStatus) {
  return ISSUE_COLUMNS.find((column) => column.status === status) ?? ISSUE_COLUMNS[0]!;
}

function IssueField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="task-board-native-field">
    <span className="task-board-native-field-label">{label}</span>
    {children}
  </label>;
}

export interface TaskBoardHostProps {
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onBack?: () => void;
  readonly onOpenSidebar?: () => void;
}

/** Wand 原生任务管理：布局与交互对标 dashi-taskboard。 */
export function TaskBoardHost({
  onOpenSession,
  onBack,
  onOpenSidebar,
}: TaskBoardHostProps = {}): React.ReactElement | null {
  const controller = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const [tasks, setTasks] = React.useState<WandTaskListed[]>([]);
  const [workspaces, setWorkspaces] = React.useState<IssueWorkspace[]>([]);
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busyId, setBusyId] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<IssueBoardView>("board");
  const [display, setDisplay] = React.useState<IssueBoardDisplay>(DEFAULT_ISSUE_BOARD_DISPLAY);
  const [filters, setFilters] = React.useState<IssueBoardFilters>(EMPTY_ISSUE_FILTERS);
  const [ganttZoom, setGanttZoom] = React.useState<IssueGanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = React.useState(false);
  const [filterWorkspaceId, setFilterWorkspaceId] = React.useState("");
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  const [projectQuery, setProjectQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createMore, setCreateMore] = React.useState(false);
  const [createExpanded, setCreateExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftState>(() => emptyDraft(""));
  const [selectedId, setSelectedId] = React.useState("");
  const [detailAgent, setDetailAgent] = React.useState<WandTaskAgent | null>(null);
  const [lastAgent, setLastAgent] = React.useState<WandTaskAgent>(() => createDefaultIssueAgent());
  const lastAgentRef = React.useRef(lastAgent);
  lastAgentRef.current = lastAgent;
  const [collapsedList, setCollapsedList] = React.useState<Record<WandTaskStatus, boolean>>({
    todo: false,
    doing: false,
    done: false,
  });
  const [draggedId, setDraggedId] = React.useState("");
  const [dropStatus, setDropStatus] = React.useState<WandTaskStatus | "">("");
  const [contextMenu, setContextMenu] = React.useState<{ taskId: string; x: number; y: number } | null>(null);
  const loadGenerationRef = React.useRef(0);
  const titleRef = React.useRef<HTMLTextAreaElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const reload = React.useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError("");
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

  React.useEffect(() => {
    if (!controller.open) return;
    setDisplay(readIssueBoardDisplay());
    void reload();
    void taskBoardRepository.workspaces()
      .then((next) => setWorkspaces(next))
      .catch(() => setWorkspaces([]));
    void taskBoardRepository.models()
      .then((payload) => setCatalog(normalizeIssueModelCatalog(payload)))
      .catch(() => setCatalog(null));
    void taskBoardRepository.agentDefaults()
      .then((next) => {
        lastAgentRef.current = next;
        setLastAgent(next);
      })
      .catch(() => undefined);
  }, [controller.open, controller.revision, reload]);

  React.useEffect(() => {
    setError("");
    setNotice("");
    setSelectedId("");
    setDetailAgent(null);
    setCreateOpen(false);
    setQuery("");
    setView("board");
    setFilters(EMPTY_ISSUE_FILTERS);
    setProjectMenuOpen(false);
    setContextMenu(null);
  }, [controller.revision, controller.open]);

  React.useEffect(() => {
    if (!controller.workspaceId) return;
    setFilterWorkspaceId((current) => current || controller.workspaceId);
    setDraft((current) => (current.workspaceId ? current : { ...current, workspaceId: controller.workspaceId }));
  }, [controller.workspaceId, controller.open]);

  const runFor = React.useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
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
    void taskBoardRepository.saveAgentDefaults(agent);
  }, []);

  const openCreate = React.useCallback((status: WandTaskStatus = "todo") => {
    setDraft(emptyDraft(filterWorkspaceId || controller.workspaceId, status, lastAgentRef.current));
    setCreateExpanded(false);
    setCreateOpen(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [controller.workspaceId, filterWorkspaceId]);

  const createTask = React.useCallback(async (): Promise<void> => {
    const submitTitle = draft.title.trim();
    const submitDescription = draft.description.trim();
    // 标题是可选字段：只写描述也能创建，标题由服务端按描述自动生成。
    if ((!submitTitle && !submitDescription) || loading) return;
    await runFor("__create__", async () => {
      const created = await taskBoardRepository.create({
        workspaceId: draft.workspaceId || null,
        title: submitTitle,
        description: submitDescription,
        status: draft.status,
        priority: draft.priority,
        labels: draft.labels.split(/[,，]/).map((label) => label.trim()).filter(Boolean),
        dueDate: draft.dueDate || null,
        agent: draft.agent,
      });
      rememberAgent(draft.agent);
      // 第一条描述就是当前任务的第一次指派：有描述就立刻派给所选 Agent。
      if (submitDescription && isDispatchableIssueAgent(draft.agent)) {
        try {
          const result = await taskBoardRepository.dispatch(created.id, draft.agent, {
            prompt: submitDescription,
            workspaceId: draft.workspaceId || null,
          });
          setNotice(`${issueAgentProviderLabel(result.session.provider)} 已开始处理「${created.title}」`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "任务已创建，但第一次指派失败。");
        }
      }
      if (createMore) {
        setDraft(emptyDraft(draft.workspaceId, draft.status, draft.agent));
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        setCreateOpen(false);
        setDraft(emptyDraft(draft.workspaceId, "todo", draft.agent));
      }
      await reload();
      if (!submitTitle && created.titleSource === "auto") {
        void refreshGeneratedTitle(created.id, created.title, reload);
      }
    });
  }, [createMore, draft, loading, rememberAgent, reload, runFor]);

  const patchTask = React.useCallback(async (id: string, patch: Parameters<typeof taskBoardRepository.update>[1]) => {
    await runFor(id, async () => {
      await taskBoardRepository.update(id, patch);
      await reload();
    });
  }, [reload, runFor]);

  const removeTask = React.useCallback(async (task: WandTaskListed): Promise<void> => {
    await runFor(task.id, async () => {
      await taskBoardRepository.remove(task.id);
      if (selectedId === task.id) {
        setSelectedId("");
        setDetailAgent(null);
      }
      await reload();
    });
  }, [reload, runFor, selectedId]);

  const dispatchTask = React.useCallback(async (task: WandTaskListed, agent: WandTaskAgent, prompt: string): Promise<void> => {
    rememberAgent(agent);
    await runFor(task.id, async () => {
      await taskBoardRepository.update(task.id, { agent, workspaceId: task.workspaceId });
      const result = await taskBoardRepository.dispatch(task.id, agent, {
        prompt: prompt.trim(),
        workspaceId: task.workspaceId,
      });
      setNotice(`${issueAgentProviderLabel(result.session.provider)} 已开始处理「${task.title}」`);
      await reload();
    });
  }, [reload, rememberAgent, runFor]);

  const dropTask = React.useCallback(async (status: WandTaskStatus, taskId: string, beforeIndex: number) => {
    const patches = reorderIssues(tasks, taskId, status, beforeIndex);
    if (patches.length === 0) return;
    setTasks((current) => current.map((task) => {
      const patch = patches.find((entry) => entry.id === task.id);
      return patch ? { ...task, status: patch.status, sortOrder: patch.sortOrder } : task;
    }));
    await runFor(taskId, async () => {
      await Promise.all(patches.map((patch) => taskBoardRepository.update(patch.id, {
        status: patch.status,
        sortOrder: patch.sortOrder,
      })));
      await reload();
    });
  }, [reload, runFor, tasks]);

  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const visible = sortIssues(filterIssues(tasks, query, filterWorkspaceId, filters));
  const grouped = groupIssuesByStatus(visible);
  const workspaceOptions = issueWorkspaceOptions(workspaces);
  const projectName = filterWorkspaceId
    ? workspaces.find((workspace) => workspace.id === filterWorkspaceId)?.name ?? "项目"
    : "所有项目";
  const projectChoices = workspaces.filter((workspace) => {
    const needle = projectQuery.trim().toLowerCase();
    if (!needle) return true;
    return `${workspace.name} ${workspace.cwd}`.toLowerCase().includes(needle);
  });
  const mainColumns = ISSUE_COLUMNS.filter((column) => display.mainStatuses.includes(column.status));
  const otherColumns = ISSUE_COLUMNS.filter((column) => !display.mainStatuses.includes(column.status));
  const detailBusy = selected ? busyId === selected.id : false;
  const detailAgentValue = detailAgent ?? (selected ? agentOf(selected, lastAgent) : lastAgent);
  const contextTask = contextMenu ? tasks.find((task) => task.id === contextMenu.taskId) ?? null : null;
  const filterActive = issueFilterCount(filters) > 0;

  React.useEffect(() => {
    if (!selected) {
      setDetailAgent(null);
      return;
    }
    setDetailAgent(agentOf(selected, lastAgentRef.current));
  }, [selected?.id, selected?.agent]);

  React.useEffect(() => {
    if (!projectMenuOpen) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".task-board-project-switcher")) return;
      setProjectMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [projectMenuOpen]);

  React.useEffect(() => {
    if (!controller.open) return;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
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
      if (event.key !== "Escape") return;
      if (createOpen) {
        setCreateOpen(false);
        return;
      }
      if (selectedId) {
        setSelectedId("");
        return;
      }
      onBack ? onBack() : taskBoardController.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controller.open, createOpen, onBack, openCreate, selectedId]);

  if (!controller.open) return null;

  const renderCard = (task: WandTaskListed): React.ReactElement => {
    const assigned = task.agent;
    const busy = busyId === task.id;
    return <article
      key={task.id}
      className={classNames(
        "task-board-card",
        `is-${task.status}`,
        draggedId === task.id && "is-dragging",
        dropStatus === task.status && draggedId && draggedId !== task.id && "is-shift",
        busy && "is-busy",
      )}
      data-task-id={task.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData(TASK_MIME, task.id);
        setDraggedId(task.id);
      }}
      onDragEnd={() => {
        setDraggedId("");
        setDropStatus("");
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ taskId: task.id, x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className="task-board-card-open"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => setSelectedId(task.id)}
      />
      <div className="task-board-card-topline">
        <span className="task-board-card-id">ID: {task.identifier}</span>
        {task.status === "done" ? <TaskBoardCompleteButton onClick={() => void patchTask(task.id, { status: "done" })}/> : null}
      </div>
      <h3 id={`task-${task.id}-title`}>{task.title}</h3>
      {display.body && task.description && task.sessions.length === 0 && !task.agent
        ? <p className="task-board-card-body">{task.description}</p>
        : null}
      <TaskBoardProgressRow task={task}/>
      <div className="task-board-card-meta" aria-label="任务属性">
        <TaskBoardProjectChip name={task.workspace ? task.workspace.name : "未指定项目"}/>
        <TaskBoardPriorityChip priority={task.priority}/>
        {task.labels.slice(0, 2).map((label) => <TaskBoardLabelChip key={label} label={label}/>)}
        {task.labels.length > 2 ? <span className="task-board-label-more">+{task.labels.length - 2}</span> : null}
        {task.dueDate ? <span className={classNames("task-board-due", issueIsOverdue(task.dueDate, task.status) && "is-overdue")}>
          {issueDueStamp(task.dueDate)}
        </span> : null}
        <TaskBoardAgentChips sessions={task.sessions} assigned={assigned}/>
      </div>
      {task.status === "doing"
        ? <TaskBoardProcessingRow task={task} onOpenSession={onOpenSession}/>
        : task.sessions.length > 0
          ? <div className="task-board-card-sessions">
              <TaskBoardConversationButton sessions={task.sessions} onOpen={onOpenSession}/>
            </div>
          : null}
    </article>;
  };

  const renderColumn = (status: WandTaskStatus): React.ReactElement => {
    const column = columnOf(status);
    const items = grouped[status];
    return <section
      key={status}
      className={classNames("task-board-column", `is-${status}`, dropStatus === status && "is-drop-target")}
      aria-labelledby={`column-${status}`}
      onDragEnter={() => setDropStatus(status)}
      onDragOver={(event) => {
        event.preventDefault();
        setDropStatus(status);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDropStatus((current) => current === status ? "" : current);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData(TASK_MIME) || event.dataTransfer.getData("text/plain");
        const list = event.currentTarget.querySelector<HTMLElement>(".task-board-column-list");
        const index = list ? dropIndexFromPoint(list, event.clientY, id) : items.length;
        setDropStatus("");
        setDraggedId("");
        if (id) void dropTask(status, id, index);
      }}
    >
      <header className="task-board-column-head">
        <div className="task-board-column-heading">
          <TaskBoardStatusGlyph status={status}/>
          <h2 id={`column-${status}`}>{column.label}{items.length > 0 ? ` ${items.length}` : ""}</h2>
        </div>
        <div className="task-board-column-actions">
          <button
            type="button"
            className="task-board-icon-button"
            aria-label={`在${column.label}中新建任务`}
            title={`添加到${column.label}`}
            onClick={() => openCreate(status)}
          >
            <WandIcon name="plus" size={12}/>
          </button>
        </div>
      </header>
      <div className="task-board-column-list">
        {loading && tasks.length === 0
          ? <>
              <WandSkeleton className="task-board-skeleton"/>
              <WandSkeleton className="task-board-skeleton"/>
            </>
          : null}
        {!loading && items.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
        {items.map(renderCard)}
      </div>
    </section>;
  };

  return <section className="task-board-native-page" aria-label="任务管理">
    <header className="task-board-workspace-header">
      <div className="task-board-kicker">
        {onOpenSidebar ? (
          <button type="button" className="task-board-icon-button" aria-label="打开任务" onClick={onOpenSidebar}>
            <WandIcon name="rail" size={14}/>
          </button>
        ) : null}
        <button
          type="button"
          className="task-board-icon-button"
          aria-label="返回"
          title="返回"
          onClick={() => onBack ? onBack() : taskBoardController.close()}
        >
          <WandIcon name="chevronLeft" size={14}/>
        </button>
        <div className="task-board-project-switcher">
          <button
            type="button"
            className="task-board-project-button"
            aria-label="切换项目"
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            onClick={() => setProjectMenuOpen((open) => !open)}
          >
            <span className="task-board-project-name">{projectName}</span>
            <WandIcon name="chevron" size={12}/>
          </button>
          {projectMenuOpen && <div className="task-board-project-menu" role="menu" aria-label="项目">
            <span>切换项目</span>
            <div className="task-board-project-search">
              <WandIcon name="search" size={12}/>
              <input
                type="search"
                value={projectQuery}
                placeholder="筛选项目…"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setProjectQuery(value);
                }}
              />
            </div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!filterWorkspaceId}
              onClick={() => {
                setFilterWorkspaceId("");
                setProjectMenuOpen(false);
              }}
            >
              <WandIcon name="folder" size={14}/>
              <span>所有项目</span>
            </button>
            {projectChoices.map((workspace) => <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={filterWorkspaceId === workspace.id}
              onClick={() => {
                setFilterWorkspaceId(workspace.id);
                setProjectMenuOpen(false);
              }}
            >
              <WandIcon name="folder" size={14}/>
              <span>{workspace.name}</span>
            </button>)}
          </div>}
        </div>
      </div>

      {!selected && <div className="task-board-view-tabs" role="tablist" aria-label="看板视图">
        {ISSUE_BOARD_VIEWS.map((entry) => <button
          key={entry.value}
          type="button"
          role="tab"
          className={classNames("task-board-view-tab", view === entry.value && "is-active")}
          aria-pressed={view === entry.value}
          onClick={() => setView(entry.value)}
        >
          {entry.label}
        </button>)}
      </div>}

      <div className="task-board-header-actions">
        {!selected && <>
          <label className={classNames("task-board-search", query && "has-value")}>
            <TaskBoardSearchIcon size={13}/>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="搜索任务"
              aria-label="搜索任务"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setQuery(value);
              }}
            />
            {!query && <kbd>/</kbd>}
          </label>
          {(view === "board" || view === "list" || view === "gantt") && <TaskBoardFilterMenu
            tasks={tasks}
            filters={filters}
            onChange={setFilters}
          />}
          {view === "board" && <TaskBoardDisplayMenu display={display} onChange={persistDisplay}/>}
          <button
            type="button"
            className="task-board-icon-button task-board-create-button"
            aria-label="新建任务"
            title="新建议题 (C)"
            onClick={() => openCreate("todo")}
          >
            <WandIcon name="plus" size={14}/>
          </button>
        </>}
      </div>
    </header>

    {error && <p className="task-board-native-banner is-error" role="alert">{error}</p>}
    {notice && <p className="task-board-native-banner is-notice" role="status">{notice}</p>}
    {filterActive && !selected && <p className="task-board-native-banner is-notice" role="status">
      当前筛选已启用
    </p>}

    {selected ? <IssueDetail
      task={selected}
      busy={detailBusy}
      catalog={catalog}
      agent={detailAgentValue}
      workspaceOptions={workspaceOptions}
      onAgentChange={(agent) => {
        setDetailAgent(agent);
        rememberAgent(agent);
      }}
      onPatch={(patch) => void patchTask(selected.id, patch)}
      onDispatch={(prompt) => void dispatchTask(selected, detailAgentValue, prompt)}
      onRemove={() => void removeTask(selected)}
      onOpenSession={onOpenSession}
      onClose={() => setSelectedId("")}
    /> : view === "dashboard" ? <TaskBoardDashboard
      projectName={projectName}
      tasks={visible}
      onOpen={setSelectedId}
      onOpenSession={onOpenSession}
    /> : view === "list" ? <TaskBoardListView
      grouped={grouped}
      collapsed={collapsedList}
      onToggle={(status) => setCollapsedList((current) => ({ ...current, [status]: !current[status] }))}
      onOpen={setSelectedId}
      onOpenSession={onOpenSession}
    /> : view === "gantt" ? <TaskBoardGantt
      grouped={grouped}
      zoom={ganttZoom}
      hideCompleted={ganttHideCompleted}
      onZoom={setGanttZoom}
      onHideCompleted={setGanttHideCompleted}
      onOpen={setSelectedId}
    /> : <div className={classNames("task-board-layout", otherColumns.length > 0 && "has-other-tasks")}>
      <div className="task-board-scroll">
        <div className="task-board-board" style={{ "--main-column-count": Math.max(mainColumns.length, 1) } as React.CSSProperties}>
          {mainColumns.map((column) => renderColumn(column.status))}
        </div>
      </div>
      {otherColumns.length > 0 && <aside className="task-board-other" aria-label="其他任务">
        {otherColumns.map((column) => renderColumn(column.status))}
      </aside>}
    </div>}

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
        void dispatchTask(contextTask, agentOf(contextTask, lastAgentRef.current), contextTask.description);
        setContextMenu(null);
      }}
      onArchive={() => {
        void removeTask(contextTask);
        setContextMenu(null);
      }}
      onClose={() => setContextMenu(null)}
    />}

    <WandDialogSurface
      open={createOpen}
      title="新建任务"
      className={classNames("wand-ui-dialog-content", "task-board-create-dialog", createExpanded && "is-expanded")}
      overlayClassName="wand-ui-dialog-overlay task-board-create-overlay"
      titleClassName="task-board-create-title"
      headerClassName="task-board-create-heading"
      description="标题可选。填写描述并选择 Agent 后，这段描述会作为第一次指派发出。"
      closeLabel="关闭编辑器"
      onOpenChange={(open) => {
        if (!open) setCreateOpen(false);
      }}
    >
      <form
        className="task-board-create-form task-board-native-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void createTask();
        }}
      >
        {/* 标题是可选字段：留空就按描述自动生成，所以这里刻意做得比描述框更轻。 */}
        <div className="task-board-create-title-field">
          <span className="task-board-create-title-label" id="task-board-create-title-label">
            任务标题
            <em>可选</em>
          </span>
          <textarea
            ref={titleRef}
            className="task-board-create-title-input"
            rows={1}
            value={draft.title}
            placeholder="不填写则按描述自动生成"
            aria-labelledby="task-board-create-title-label"
            maxLength={240}
            onChange={(event) => {
              const value = event.currentTarget.value.replace(/\n/g, "");
              setDraft((current) => ({ ...current, title: value }));
            }}
          />
        </div>
        <textarea
          className="task-board-create-body-input"
          rows={4}
          value={draft.description}
          placeholder="添加描述…（将作为第一个 Agent 的指派内容）"
          aria-label="任务描述（作为第一次指派）"
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDraft((current) => ({ ...current, description: value }));
          }}
        />
        <div className="task-board-create-properties">
          <WandSelect
            value={issueWorkspaceSelectValue(draft.workspaceId)}
            options={workspaceOptions}
            ariaLabel="指定项目目录"
            placeholder="选择项目目录"
            searchable
            searchPlaceholder="搜索项目"
            className="task-board-native-select"
            onValueChange={(value) => setDraft((current) => ({ ...current, workspaceId: issueWorkspaceIdFromSelect(value) ?? "" }))}
          />
          <WandSelect
            value={draft.status}
            options={ISSUE_COLUMNS.map((column) => ({ value: column.status, label: column.label }))}
            ariaLabel="状态"
            className="task-board-native-select"
            onValueChange={(status) => setDraft((current) => ({ ...current, status: status as WandTaskStatus }))}
          />
          <WandSelect
            value={draft.priority}
            options={ISSUE_PRIORITIES.map((entry) => ({ value: entry.value, label: entry.label }))}
            ariaLabel="优先级"
            className="task-board-native-select"
            onValueChange={(priority) => setDraft((current) => ({ ...current, priority: priority as WandTaskPriority }))}
          />
          <label className="task-board-due-field">
            <span>截止日期</span>
            <input
              type="date"
              value={draft.dueDate}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, dueDate: value }));
              }}
            />
          </label>
          <WandSelect
            value={draft.agent.provider}
            options={ISSUE_AGENT_PROVIDERS.map((entry) => ({ value: entry.value, label: entry.label }))}
            ariaLabel="第一次指派的 CLI 工具"
            className="task-board-native-select"
            onValueChange={(provider) => setDraft((current) => ({
              ...current,
              agent: withIssueAgentProvider(current.agent, provider as WandTaskAgent["provider"], catalog),
            }))}
          />
          <WandSelect
            value={draft.agent.model}
            options={issueAgentModelOptions(catalog, draft.agent.provider)}
            ariaLabel="第一次指派的模型"
            searchable
            searchPlaceholder="搜索模型"
            className="task-board-native-select"
            onValueChange={(model) => setDraft((current) => ({ ...current, agent: { ...current.agent, model } }))}
          />
          <WandSelect
            value={draft.agent.thinkingEffort}
            options={ISSUE_AGENT_EFFORTS.map((entry) => ({ value: entry.value, label: entry.label }))}
            ariaLabel="第一次指派的思考深度"
            className="task-board-native-select"
            onValueChange={(effort) => setDraft((current) => ({
              ...current,
              agent: { ...current.agent, thinkingEffort: effort as WandTaskAgent["thinkingEffort"] },
            }))}
          />
          <label className="task-board-due-field">
            <span>标签</span>
            <input
              type="text"
              value={draft.labels}
              placeholder="用逗号分隔"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, labels: value }));
              }}
            />
          </label>
        </div>
        <div className="task-board-create-footer">
          <WandSwitch
            checked={createMore}
            onCheckedChange={setCreateMore}
            ariaLabel="创建更多"
            label="创建更多"
          />
          <button
            type="button"
            className="task-board-icon-button"
            aria-label={createExpanded ? "收起编辑器" : "展开编辑器"}
            onClick={() => setCreateExpanded((open) => !open)}
          >
            <WandIcon name={createExpanded ? "chevron" : "up"} size={14}/>
          </button>
          <WandButton
            kind="primary"
            type="submit"
            disabled={(!draft.title.trim() && !draft.description.trim()) || busyId === "__create__"}
          >
            {busyId === "__create__" ? "正在保存…" : draft.description.trim() ? "创建并指派" : "创建任务"}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  </section>;
}

function IssueDetail({
  task,
  busy,
  catalog,
  agent,
  workspaceOptions,
  onAgentChange,
  onPatch,
  onDispatch,
  onRemove,
  onOpenSession,
  onClose,
}: {
  task: WandTaskListed;
  busy: boolean;
  catalog: IssueModelCatalog | null;
  agent: WandTaskAgent;
  workspaceOptions: ReturnType<typeof issueWorkspaceOptions>;
  onAgentChange(agent: WandTaskAgent): void;
  onPatch(patch: Parameters<typeof taskBoardRepository.update>[1]): void;
  onDispatch(prompt: string): void;
  onRemove(): void;
  onOpenSession?: (sessionId: string) => void;
  onClose(): void;
}): React.ReactElement {
  const [title, setTitle] = React.useState(task.title);
  const [labelDraft, setLabelDraft] = React.useState(task.labels.join(", "));
  const hasAgents = task.sessions.length > 0;
  const [composeOpen, setComposeOpen] = React.useState(!hasAgents);
  const [composePrompt, setComposePrompt] = React.useState(hasAgents ? "" : task.description);
  const knownLabels = collectIssueLabels([task]);
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

  React.useEffect(() => {
    setTitle(task.title);
    setLabelDraft(task.labels.join(", "));
    const assigned = task.sessions.length > 0;
    setComposeOpen(!assigned);
    setComposePrompt(assigned ? "" : task.description);
  }, [task.id, task.title, task.description, task.labels, task.sessions.length]);

  return <div className="task-board-detail" aria-label="任务详情">
    <div className="task-board-detail-scroll">
      <div className="task-board-detail-layout">
        <div className="task-board-detail-main">
          <button type="button" className="task-board-detail-back" onClick={onClose}>
            <WandIcon name="chevronLeft" size={14}/>返回任务管理
          </button>
          <p className="task-board-detail-id">ID: {task.identifier}</p>
          <textarea
            className="task-board-detail-title"
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
            onOpenSession={onOpenSession}
          />
          {composeOpen ? <section className="task-board-native-assign" aria-label="指派 Agent">
            <div className="task-board-native-assign-head">
              <strong>{task.sessions.length > 0 ? "再指派一个 Agent" : "指派 Agent"}</strong>
              <small>先输入提示词，再选参数直接派发</small>
            </div>
            <textarea
              className="task-board-detail-body"
              rows={5}
              value={composePrompt}
              placeholder="输入这次派给 Agent 的提示词…"
              aria-label="派发提示词"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setComposePrompt(value);
              }}
            />
            <div className="task-board-native-editor-grid is-assign">
              <IssueField label="CLI 工具">
                <WandSelect
                  value={agent.provider}
                  options={ISSUE_AGENT_PROVIDERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                  ariaLabel="任务 CLI 工具"
                  className="task-board-native-select"
                  disabled={busy}
                  onValueChange={(provider) => onAgentChange(
                    withIssueAgentProvider(agent, provider as WandTaskAgent["provider"], catalog),
                  )}
                />
              </IssueField>
              <IssueField label="模型">
                <WandSelect
                  value={agent.model}
                  options={issueAgentModelOptions(catalog, agent.provider)}
                  ariaLabel="任务模型"
                  searchable
                  searchPlaceholder="搜索模型"
                  className="task-board-native-select"
                  disabled={busy}
                  onValueChange={(model) => onAgentChange({ ...agent, model })}
                />
              </IssueField>
              <IssueField label="思考深度">
                <WandSelect
                  value={agent.thinkingEffort}
                  options={ISSUE_AGENT_EFFORTS.map((entry) => ({ value: entry.value, label: entry.label }))}
                  ariaLabel="任务思考深度"
                  className="task-board-native-select"
                  disabled={busy}
                  onValueChange={(effort) => onAgentChange({
                    ...agent,
                    thinkingEffort: effort as WandTaskAgent["thinkingEffort"],
                  })}
                />
              </IssueField>
            </div>
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
                {busy ? "正在派发…" : "派发 Agent"}
              </WandButton>
            </div>
          </section> : <button
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
          </button>}
        </div>
        <aside className="task-board-detail-properties" aria-label="属性">
          <h2>属性</h2>
          <IssueField label="状态">
            <WandSelect
              value={task.status}
              options={ISSUE_COLUMNS.map((column) => ({ value: column.status, label: column.label }))}
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
              onValueChange={(value) => onPatch({ workspaceId: issueWorkspaceIdFromSelect(value) })}
            />
          </IssueField>
          <IssueField label="截止日期">
            <input
              type="date"
              className="task-board-detail-date"
              value={task.dueDate ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                onPatch({ dueDate: value || null });
              }}
            />
          </IssueField>
          <IssueField label="标签">
            <input
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
        </aside>
      </div>
    </div>
  </div>;
}

