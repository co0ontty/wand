import * as React from "react";
import type { WandTaskAgent, WandTaskPriority, WandTaskStatus } from "../../../task-types";
import { ProviderLogo } from "../provider-logo";
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
  createDefaultIssueAgent,
  DEFAULT_ISSUE_BOARD_DISPLAY,
  dropIndexFromPoint,
  filterIssues,
  formatIssueStamp,
  groupIssuesByStatus,
  ISSUE_AGENT_EFFORTS,
  ISSUE_AGENT_PROVIDERS,
  ISSUE_BOARD_VIEWS,
  ISSUE_COLUMNS,
  issueAgentModelOptions,
  issueAgentProviderLabel,
  issueStatusTone,
  issueWorkspaceIdFromSelect,
  issueWorkspaceOptions,
  issueWorkspaceSelectValue,
  normalizeIssueModelCatalog,
  readIssueBoardDisplay,
  reorderIssues,
  sortIssues,
  withIssueAgentProvider,
  writeIssueBoardDisplay,
  type IssueBoardDisplay,
  type IssueBoardView,
  type IssueModelCatalog,
} from "./task-board-agent";
import { taskBoardController, taskBoardStore } from "./task-board-controller";
import { taskBoardRepository, type IssueWorkspace, type WandTaskListed } from "./task-board-repository";

const PRIORITY_OPTIONS: ReadonlyArray<{ value: WandTaskPriority; label: string }> = [
  { value: "none", label: "无优先级" },
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

const PRIORITY_LABELS: Record<WandTaskPriority, string> = {
  none: "无优先级",
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

const TASK_MIME = "application/x-wand-task";

interface DraftState {
  workspaceId: string;
  title: string;
  description: string;
  status: WandTaskStatus;
  priority: WandTaskPriority;
}

function emptyDraft(workspaceId: string, status: WandTaskStatus = "todo"): DraftState {
  return { workspaceId, title: "", description: "", status, priority: "none" };
}

function agentOf(task: WandTaskListed): WandTaskAgent {
  return task.agent ?? createDefaultIssueAgent();
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

function StatusGlyph({ status }: { status: WandTaskStatus }) {
  const tone = issueStatusTone(status);
  return <span className={`task-board-status-glyph is-${tone}`} aria-hidden="true">
    {tone === "done"
      ? <WandIcon name="check" size={11} strokeWidth={2.2}/>
      : tone === "progress"
        ? <WandIcon name="circle" size={11} strokeWidth={2.2}/>
        : <WandIcon name="circle" size={11} strokeWidth={1.6}/>}
  </span>;
}

function PriorityMark({ priority }: { priority: WandTaskPriority }) {
  if (priority === "none") return null;
  return <span className={`task-board-priority is-${priority}`} title={`${PRIORITY_LABELS[priority]}优先级`}>
    <WandIcon name={priority === "urgent" || priority === "high" ? "warning" : "up"} size={11} strokeWidth={2}/>
    {PRIORITY_LABELS[priority]}
  </span>;
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
  const [filterWorkspaceId, setFilterWorkspaceId] = React.useState("");
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  const [projectQuery, setProjectQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createMore, setCreateMore] = React.useState(false);
  const [createExpanded, setCreateExpanded] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftState>(() => emptyDraft(""));
  const [selectedId, setSelectedId] = React.useState("");
  const [detailAgent, setDetailAgent] = React.useState<WandTaskAgent | null>(null);
  const [collapsedList, setCollapsedList] = React.useState<Record<WandTaskStatus, boolean>>({
    todo: false,
    doing: false,
    done: false,
  });
  const [draggedId, setDraggedId] = React.useState("");
  const [dropStatus, setDropStatus] = React.useState<WandTaskStatus | "">("");
  const loadGenerationRef = React.useRef(0);
  const titleRef = React.useRef<HTMLTextAreaElement>(null);

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
  }, [controller.open, controller.revision, reload]);

  React.useEffect(() => {
    setError("");
    setNotice("");
    setSelectedId("");
    setDetailAgent(null);
    setCreateOpen(false);
    setQuery("");
    setView("board");
    setProjectMenuOpen(false);
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

  const openCreate = React.useCallback((status: WandTaskStatus = "todo") => {
    setDraft(emptyDraft(filterWorkspaceId || controller.workspaceId, status));
    setCreateExpanded(false);
    setCreateOpen(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [controller.workspaceId, filterWorkspaceId]);

  const createTask = React.useCallback(async (): Promise<void> => {
    if (!draft.title.trim() || loading) return;
    await runFor("__create__", async () => {
      await taskBoardRepository.create({
        workspaceId: draft.workspaceId || null,
        title: draft.title.trim(),
        description: draft.description.trim(),
        status: draft.status,
        priority: draft.priority,
        labels: [],
        agent: null,
      });
      if (createMore) {
        setDraft(emptyDraft(draft.workspaceId, draft.status));
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        setCreateOpen(false);
        setDraft(emptyDraft(draft.workspaceId));
      }
      await reload();
    });
  }, [createMore, draft, loading, reload, runFor]);

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

  const dispatchTask = React.useCallback(async (task: WandTaskListed, agent: WandTaskAgent): Promise<void> => {
    await runFor(task.id, async () => {
      await taskBoardRepository.update(task.id, { agent });
      const result = await taskBoardRepository.dispatch(task.id, agent);
      setNotice(`${issueAgentProviderLabel(result.session.provider)} 已开始处理「${task.title}」`);
      await reload();
    });
  }, [reload, runFor]);

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
  const visible = sortIssues(filterIssues(tasks, query, filterWorkspaceId));
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
  const detailAgentValue = detailAgent ?? (selected ? agentOf(selected) : createDefaultIssueAgent());

  React.useEffect(() => {
    if (!selected) {
      setDetailAgent(null);
      return;
    }
    setDetailAgent(agentOf(selected));
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
  }, [controller.open, createOpen, onBack, selectedId]);

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
    >
      <button
        type="button"
        className="task-board-card-open"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => setSelectedId(task.id)}
      />
      <div className="task-board-card-topline">
        <span className="task-board-card-id">ID: {task.identifier}</span>
      </div>
      <h3 id={`task-${task.id}-title`}>{task.title}</h3>
      {display.body && task.description ? <p className="task-board-card-body">{task.description}</p> : null}
      <div className="task-board-card-meta" aria-label="任务属性">
        <span className="task-board-chip" title={task.workspace?.cwd ?? "未指定项目目录"}>
          <WandIcon name="folder" size={12}/>
          <span>{task.workspace ? task.workspace.name : "未指定项目"}</span>
        </span>
        <PriorityMark priority={task.priority}/>
        {task.labels.slice(0, 2).map((label) => <span key={label} className="task-board-chip is-label">{label}</span>)}
        {task.dueDate ? <span className="task-board-chip">{formatIssueStamp(task.dueDate)}</span> : null}
        <span className={classNames("task-board-chip", !assigned && "is-muted")}>
          {assigned
            ? <>
                <ProviderLogo provider={assigned.provider} className="task-board-agent-logo"/>
                {issueAgentProviderLabel(assigned.provider)}
              </>
            : "未指派"}
        </span>
      </div>
      {task.sessions.length > 0 && <div className="task-board-card-sessions">
        {task.sessions.map((session) => <button
          key={session.id}
          type="button"
          className="task-board-session"
          title={session.title || session.id}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenSession?.(session.id);
          }}
        >
          <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
          {issueAgentProviderLabel(session.provider)}
        </button>)}
      </div>}
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
          <StatusGlyph status={status}/>
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
          <button type="button" className="task-board-icon-button" aria-label="打开任务与项目" onClick={onOpenSidebar}>
            <WandIcon name="rail" size={14}/>
          </button>
        ) : null}
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

      <div className="task-board-view-tabs" role="tablist" aria-label="看板视图">
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
      </div>

      <div className="task-board-header-actions">
        <label className={classNames("task-board-search", query && "has-value")}>
          <WandIcon name="search" size={13}/>
          <input
            type="search"
            value={query}
            placeholder="搜索任务"
            aria-label="搜索任务"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setQuery(value);
            }}
          />
        </label>
        <WandButton kind="ghost" size="small" onClick={() => void reload()} disabled={loading}>
          <WandIcon name="refresh" size={14} className={loading ? "is-spinning" : undefined}/>{loading ? "加载中…" : "刷新"}
        </WandButton>
        <WandPopoverDisplay display={display} onChange={persistDisplay}/>
        <WandButton kind="ghost" size="small" onClick={() => onBack ? onBack() : taskBoardController.close()}>
          <WandIcon name="chevronLeft" size={14}/>返回
        </WandButton>
      </div>
    </header>

    {error && <p className="task-board-native-banner is-error" role="alert">{error}</p>}
    {notice && <p className="task-board-native-banner is-notice" role="status">{notice}</p>}

    {selected ? <IssueDetail
      task={selected}
      busy={detailBusy}
      catalog={catalog}
      agent={detailAgentValue}
      workspaceOptions={workspaceOptions}
      onAgentChange={setDetailAgent}
      onPatch={(patch) => void patchTask(selected.id, patch)}
      onDispatch={() => void dispatchTask(selected, detailAgentValue)}
      onRemove={() => void removeTask(selected)}
      onOpenSession={onOpenSession}
      onClose={() => setSelectedId("")}
    /> : view === "list" ? <div className="task-board-list-view">
      {ISSUE_COLUMNS.map((column) => {
        const items = grouped[column.status];
        const collapsed = collapsedList[column.status];
        return <section key={column.status} className={`task-board-list-group is-${column.status}`}>
          <button
            type="button"
            className="task-board-list-header"
            aria-expanded={!collapsed}
            onClick={() => setCollapsedList((current) => ({ ...current, [column.status]: !current[column.status] }))}
          >
            <WandIcon name={collapsed ? "chevronLeft" : "chevron"} size={12}/>
            <StatusGlyph status={column.status}/>
            <strong>{column.label}</strong>
            <span>{items.length}</span>
          </button>
          {!collapsed && <div className="task-board-list-rows">
            {items.length === 0 && <p className="task-board-column-empty">{column.empty}</p>}
            {items.map((task) => <button
              key={task.id}
              type="button"
              className="task-board-list-row"
              onClick={() => setSelectedId(task.id)}
            >
              <span className="task-board-list-title">
                <small>{task.identifier}</small>
                <strong>{task.title}</strong>
              </span>
              <span className="task-board-list-meta">
                <PriorityMark priority={task.priority}/>
                <span>{task.workspace?.name ?? "未指定项目"}</span>
                <time>{formatIssueStamp(task.updatedAt)}</time>
              </span>
            </button>)}
          </div>}
        </section>;
      })}
    </div> : <div className={classNames("task-board-layout", otherColumns.length > 0 && "has-other-tasks")}>
      <div className="task-board-scroll">
        <div className="task-board-board" style={{ "--main-column-count": Math.max(mainColumns.length, 1) } as React.CSSProperties}>
          {mainColumns.map((column) => renderColumn(column.status))}
        </div>
      </div>
      {otherColumns.length > 0 && <aside className="task-board-other" aria-label="其他任务">
        {otherColumns.map((column) => renderColumn(column.status))}
      </aside>}
    </div>}

    <WandDialogSurface
      open={createOpen}
      title="新建任务"
      className={classNames("wand-ui-dialog-content", "task-board-create-dialog", createExpanded && "is-expanded")}
      overlayClassName="wand-ui-dialog-overlay task-board-create-overlay"
      titleClassName="task-board-create-title"
      headerClassName="task-board-create-heading"
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
        <textarea
          ref={titleRef}
          className="task-board-create-title-input"
          rows={1}
          value={draft.title}
          placeholder="任务标题"
          aria-label="任务标题"
          maxLength={240}
          onChange={(event) => {
            const value = event.currentTarget.value.replace(/\n/g, "");
            setDraft((current) => ({ ...current, title: value }));
          }}
        />
        <textarea
          className="task-board-create-body-input"
          rows={4}
          value={draft.description}
          placeholder="添加描述…"
          aria-label="任务描述"
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
            options={PRIORITY_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
            ariaLabel="优先级"
            className="task-board-native-select"
            onValueChange={(priority) => setDraft((current) => ({ ...current, priority: priority as WandTaskPriority }))}
          />
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
          <WandButton kind="primary" type="submit" disabled={!draft.title.trim() || busyId === "__create__"}>
            {busyId === "__create__" ? "正在保存…" : "创建任务"}
          </WandButton>
        </div>
      </form>
    </WandDialogSurface>
  </section>;
}

function WandPopoverDisplay({
  display,
  onChange,
}: {
  display: IssueBoardDisplay;
  onChange(next: IssueBoardDisplay): void;
}): React.ReactElement {
  return <details className="task-board-display">
    <summary className="task-board-icon-button" aria-label="显示设置" title="显示设置">
      <WandIcon name="eye" size={14}/>
    </summary>
    <div className="task-board-display-menu" role="dialog" aria-label="显示设置">
      <strong>显示设置</strong>
      <WandSwitch
        checked={display.body}
        onCheckedChange={(body) => onChange({ ...display, body })}
        ariaLabel="显示正文"
        label="正文"
      />
      <p>主列</p>
      {ISSUE_COLUMNS.map((column) => {
        const checked = display.mainStatuses.includes(column.status);
        return <label key={column.status} className="task-board-display-status">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => {
              const mainStatuses = checked
                ? display.mainStatuses.filter((status) => status !== column.status)
                : [...display.mainStatuses, column.status];
              onChange({
                ...display,
                mainStatuses: mainStatuses.length > 0 ? mainStatuses : [column.status],
              });
            }}
          />
          {column.label}
        </label>;
      })}
    </div>
  </details>;
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
  onDispatch(): void;
  onRemove(): void;
  onOpenSession?: (sessionId: string) => void;
  onClose(): void;
}): React.ReactElement {
  const [title, setTitle] = React.useState(task.title);
  const [description, setDescription] = React.useState(task.description);

  React.useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
  }, [task.id, task.title, task.description]);

  return <div className="task-board-detail" aria-label="任务详情">
    <div className="task-board-detail-scroll">
      <div className="task-board-detail-layout">
        <div className="task-board-detail-main">
          <button type="button" className="task-board-detail-back" onClick={onClose}>
            <WandIcon name="chevronLeft" size={14}/>返回任务管理
          </button>
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
          <textarea
            className="task-board-detail-body"
            rows={8}
            value={description}
            placeholder="添加描述…"
            aria-label="任务描述"
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDescription(value);
            }}
            onBlur={() => {
              if (description === task.description) return;
              onPatch({ description });
            }}
          />
          {task.sessions.length > 0 && <div className="task-board-card-sessions">
            {task.sessions.map((session) => <button
              key={session.id}
              type="button"
              className="task-board-session"
              onClick={() => onOpenSession?.(session.id)}
            >
              <ProviderLogo provider={session.provider} className="task-board-agent-logo"/>
              {issueAgentProviderLabel(session.provider)}{session.model ? ` · ${session.model}` : ""}
            </button>)}
          </div>}
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
              options={PRIORITY_OPTIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
              ariaLabel="任务优先级"
              className="task-board-native-select"
              disabled={busy}
              onValueChange={(priority) => onPatch({ priority: priority as WandTaskPriority })}
            />
          </IssueField>
          <IssueField label="项目目录">
            <WandSelect
              value={issueWorkspaceSelectValue(task.workspaceId)}
              options={workspaceOptions}
              ariaLabel="任务项目"
              placeholder="选择项目目录"
              searchable
              searchPlaceholder="搜索项目"
              className="task-board-native-select"
              disabled={busy}
              onValueChange={(value) => onPatch({ workspaceId: issueWorkspaceIdFromSelect(value) })}
            />
          </IssueField>
          <section className="task-board-native-assign" aria-label="指派 Agent">
            <div className="task-board-native-assign-head">
              <strong>指派 Agent</strong>
              <small>只作用于这条任务</small>
            </div>
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
            <WandButton kind="primary" size="small" className="task-board-native-dispatch" disabled={busy} onClick={onDispatch}>
              <WandIcon name="spark" size={14}/>
              {busy ? "正在派发…" : task.sessions.length > 0 ? "再派发一次" : "派发 Agent"}
            </WandButton>
          </section>
          <div className="task-board-native-editor-actions">
            <WandButton kind="danger" size="small" className="task-board-native-remove" disabled={busy} onClick={onRemove}>归档</WandButton>
          </div>
        </aside>
      </div>
    </div>
  </div>;
}
