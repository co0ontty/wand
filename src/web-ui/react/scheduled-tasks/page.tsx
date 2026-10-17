import * as React from "react";
import { Alert, DatePicker, Empty, Flex, Form, Input, InputNumber, Spin, Switch, TimePicker, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { nextScheduledTime, parseTaskSchedule } from "../../../scheduled-task-time.js";
import type { ScheduledTaskInput, ScheduledTaskSummary, TaskSchedule, ScheduledTaskCalendarResponse, ScheduledTaskRunFactView } from "../../../scheduled-task-types.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { createRequestId, HttpResponseError } from "../http-adapter.js";
import { installStyleSheet } from "../styles";
import { confirmDiscardTaskDraft } from "../task-draft-guard";
import { httpWorkspacesRepository } from "../workspaces/repository";
import type { Workspace } from "../workspaces/types";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { WandButton, WandIcon, WandIconButton, WandSelect, WandStretchTabs } from "../ui";
import { hasOpenPopupSurface, usePopupDismiss } from "../ui/popup-lifecycle";
import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem } from "../ui/dropdown-menu";
import { ConversationMorphIcon } from "../conversations/controls";
import { WandSearchField } from "../ui/search-field";
import { useReducedMotion } from "../ui/motion-tokens";
import { nextTask } from "../../../scheduled-task-agenda.js";
import { addDateDays } from "../../../scheduled-task-activity.js";
import { ScheduledPresentationProvider } from "./presentation-context";
import { NextTaskPanel, TaskAgenda } from "./agenda-view";
import { ScheduleCalendar } from "./calendar-view";
import { ScheduledTaskDetails } from "./task-detail";
import { scheduleInputError, scheduleSaveUnknown, scheduleTimeZones, scheduleLabel, scheduleDateInZone, WEEKDAYS } from "./model";
import { scheduledTasksRepository, type ScheduledTaskPatch } from "./repository";
import { scheduledTaskStyles } from "./styles";

if (typeof document !== "undefined") installStyleSheet("wand-scheduled-task-styles", scheduledTaskStyles);

export interface ScheduledTasksPageProps {
  visible: boolean;
  view?: "list" | "calendar";
  onViewChange?(view: "list" | "calendar"): void;
  calendarMode?: "month" | "week";
  onCalendarModeChange?(mode: "month" | "week"): void;
  sidebarOpen?: boolean;
  onBack(): void;
  onOpenSidebar?(): void;
  onOpenSession(id: string): void;
}

type Filter = "all" | "active" | "paused" | "finished";
type PendingSave = { kind: "create"; input: ScheduledTaskInput } | { kind: "update"; id: string; patch: ScheduledTaskPatch };

function newDraft(): ScheduledTaskInput {
  return { requestId: createRequestId(), title: "", employeeId: "", workspaceId: "", prompt: "",
    schedule: { kind: "once", runAt: dayjs().add(1, "hour").startOf("minute").toISOString() } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

function sameSavedInput(task: ScheduledTaskSummary, patch: ScheduledTaskPatch): boolean {
  return task.employeeId === patch.employeeId && task.prompt === patch.prompt && task.title === patch.title
    && (task.workspaceId ?? "") === (patch.workspaceId ?? "")
    && JSON.stringify(task.schedule) === JSON.stringify(patch.schedule) && (patch.enabled === undefined || task.enabled === patch.enabled);
}

/** Keep the page and its draft mounted; only the visible page owns polling. */
export function ScheduledTasksPage({ visible, view: controlledView, onViewChange, calendarMode, onCalendarModeChange, sidebarOpen, onBack, onOpenSidebar, onOpenSession }: ScheduledTasksPageProps): React.ReactElement {
  const [localView, setLocalView] = React.useState<"list" | "calendar">("list");
  const view = controlledView ?? localView;
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const reduced = useReducedMotion();
  const [listHidden, setListHidden] = React.useState(view !== "list");
  const [calendarHidden, setCalendarHidden] = React.useState(view !== "calendar");
  const [calendarVisited, setCalendarVisited] = React.useState(view === "calendar");
  React.useLayoutEffect(() => {
    if (view === "list") setListHidden(false);
    else { setCalendarHidden(false); setCalendarVisited(true); }
    if (reduced) { setListHidden(view !== "list"); setCalendarHidden(view !== "calendar"); }
  }, [view, reduced]);
  const [localCalendarMode, setLocalCalendarMode] = React.useState<"month" | "week">("month");
  const [clock, setClock] = React.useState(() => new Date());
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [visited, setVisited] = React.useState<string[]>([]);
  const viewRef = React.useRef(view); viewRef.current = view;
  const expandedRef = React.useRef(expanded); expandedRef.current = expanded;
  const [menuId, setMenuId] = React.useState("");
  const [calendarFeed, setCalendarFeed] = React.useState<ScheduledTaskCalendarResponse | null>(null);
  const [calendarWindow, setCalendarWindow] = React.useState(() => {
    const from = dayjs().startOf("month").startOf("week").format("YYYY-MM-DD");
    return { from, to: addDateDays(from, 41) };
  });
  const onRangeChange = React.useCallback((from: string, to: string) => setCalendarWindow(previous => previous.from === from && previous.to === to ? previous : { from, to }), []);
  const selectCalendarTask = React.useCallback((id: string | null) => { setExpanded(id ? [id] : []); setCancelId(""); }, []);
  React.useEffect(() => { setVisited(previous => [...new Set([...previous, ...expanded])]); }, [expanded]);
  const [tasks, setTasks] = React.useState<ScheduledTaskSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [mode, setMode] = React.useState<"list" | "form">("list");
  const [editing, setEditing] = React.useState<ScheduledTaskSummary | null>(null);
  const [draft, setDraft] = React.useState<ScheduledTaskInput>(newDraft);
  const draftBaseline = React.useRef(draft);
  const draftSwitchLock = React.useRef(false);
  const [formError, setFormError] = React.useState("");
  const [workspaceFieldError, setWorkspaceFieldError] = React.useState("");
  const workspaceTrigger = React.useRef<HTMLButtonElement>(null);
  const [pendingSave, setPendingSave] = React.useState<PendingSave | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveResult, setSaveResult] = React.useState(false);
  const [formFocus, setFormFocus] = React.useState(0);
  const [busyTask, setBusyTask] = React.useState("");
  const [cancelId, setCancelId] = React.useState("");
  const pageRef = React.useRef<HTMLElement>(null);
  const [documentVisible, setDocumentVisible] = React.useState(() => document.visibilityState !== "hidden");
  const loadRef = React.useRef<AbortController | null>(null);
  const readAllowed = React.useRef(false); readAllowed.current = visible && documentVisible;
  const refreshLatest = React.useRef<() => Promise<void>>(async () => {});
  const saveLock = React.useRef(false);
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const employeeData = useSiliconEmployees({ includeArchived: true, enabled: visible });
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = React.useState(false);
  const [workspaceError, setWorkspaceError] = React.useState("");

  const invalidateRead = (): void => { loadRef.current?.abort(); loadRef.current = null; setLoading(false); };

  React.useEffect(() => {
    const change = (): void => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);

  const refresh = React.useCallback(async () => {
    if (!readAllowed.current || loadRef.current) return;
    const controller = new AbortController(); loadRef.current = controller;
    setLoading(true);
    try {
      const [taskResult, workspaceResult] = await Promise.allSettled([
        view === "calendar" ? scheduledTasksRepository.calendar(calendarWindow.from, calendarWindow.to, localZone, controller.signal) : scheduledTasksRepository.list(controller.signal), httpWorkspacesRepository.list(),
      ]);
      if (controller.signal.aborted) return;
      if (taskResult.status === "fulfilled") {
        const result = taskResult.value;
        if (Array.isArray(result)) { setTasks(result); setClock(new Date()); }
        else { setCalendarFeed(result); setTasks(result.tasks); setClock(new Date(result.generatedAt)); }
        setLoaded(true); setError("");
      } else setError(view === "calendar" && taskResult.reason instanceof HttpResponseError && taskResult.reason.status === 404 ? "服务端尚不支持全局日历，请先更新服务端。已有计划不会受影响。" : errorText(taskResult.reason));
      if (workspaceResult.status === "fulfilled") {
        setWorkspaces(workspaceResult.value.filter(workspace => workspace.kind !== "global" && workspace.id !== "wand-global" && !!workspace.cwd?.trim()));
        setWorkspacesLoaded(true); setWorkspaceError("");
      } else setWorkspaceError(errorText(workspaceResult.reason));
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (loadRef.current === controller) { loadRef.current = null; setLoading(false); } }
  }, [visible, documentVisible, view, calendarWindow.from, calendarWindow.to, localZone]);

  refreshLatest.current = refresh;
  React.useEffect(() => {
    if (!visible || !documentVisible) return undefined;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => { clearInterval(timer); loadRef.current?.abort(); loadRef.current = null; };
  }, [visible, documentVisible, refresh]);

  const back = React.useCallback(() => {
    if (saving || busyTask) return;
    if (mode !== "list") setMode("list");
    else onBack();
  }, [mode, saving, busyTask, onBack]);

  React.useEffect(() => {
    if (!visible) return undefined;
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || hasOpenPopupSurface()) return;
      if (mode === "form") { event.preventDefault(); back(); return; }
      if (expanded.length) { event.preventDefault(); setExpanded([]); pageRef.current?.querySelector<HTMLButtonElement>(`[data-scheduled-task-id="${expanded[0]}"] .scheduled-task-title-button`)?.focus({ preventScroll: true }); }
      else { event.preventDefault(); back(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [visible, back, expanded, mode]);

  React.useLayoutEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    const input = pageRef.current?.querySelector<HTMLInputElement>("#scheduled-task-name");
    const focus = () => { if (!cancelled && input && getComputedStyle(input).visibility === "visible") input.focus({ preventScroll: true }); };
    const frame = requestAnimationFrame(() => {
      if (mode !== "form") { titleRef.current?.focus({ preventScroll: true }); return; }
      const shell = pageRef.current?.querySelector<HTMLElement>(".scheduled-editor-shell");
      shell?.scrollIntoView({ block: "start", behavior: "instant" });
      if (input && getComputedStyle(input).visibility === "visible") focus();
      // Inputs can still inherit a visibility transition after the shell itself
      // has settled (including Ant's reduced-motion lifecycle).
      else void Promise.allSettled(shell?.getAnimations({ subtree: true }).map(animation => animation.finished) ?? []).then(focus);
    });
    document.addEventListener("pointerdown", cancel, true); document.addEventListener("keydown", cancel, true);
    return () => { cancelled = true; cancelAnimationFrame(frame); document.removeEventListener("pointerdown", cancel, true); document.removeEventListener("keydown", cancel, true); };
  }, [visible, mode, formFocus]);
  React.useEffect(() => {
    setExpanded([]); setMenuId(""); setCancelId(""); setMode("list");
  }, [view]);

  const mergeTask = (task: ScheduledTaskSummary): void => {
    setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)]);
  };

  const draftDirty = (): boolean => draft.title !== draftBaseline.current.title || draft.employeeId !== draftBaseline.current.employeeId || draft.workspaceId !== draftBaseline.current.workspaceId || draft.prompt !== draftBaseline.current.prompt
    || JSON.stringify(draft.schedule) !== JSON.stringify(draftBaseline.current.schedule);
  const discardBeforeSwitch = async (): Promise<boolean> => {
    if (draftSwitchLock.current || saving || pendingSave) return false;
    if (!draftDirty()) return true;
    draftSwitchLock.current = true;
    try { return await confirmDiscardTaskDraft(); }
    finally { draftSwitchLock.current = false; }
  };
  const startNew = async (): Promise<void> => {
    if (pendingSave) { setMode("form"); return; }
    if (editing) {
      if (!await discardBeforeSwitch()) return;
      const next = newDraft(); draftBaseline.current = next; setDraft(next); setEditing(null);
    }
    setExpanded([]); setFormError(""); setSaveResult(false); setMode("form"); setFormFocus(value => value + 1);
    setWorkspaceFieldError("");
  };
  const edit = async (task: ScheduledTaskSummary): Promise<void> => {
    if (pendingSave) { setMode("form"); return; }
    if (editing?.id === task.id) { setMode("form"); setFormFocus(value => value + 1); return; }
    if (!await discardBeforeSwitch()) return;
    const next = { requestId: createRequestId(), title: task.title, employeeId: task.employeeId, workspaceId: task.workspaceId ?? "", prompt: task.prompt, schedule: task.schedule };
    draftBaseline.current = next; setEditing(task); setDraft(next); setExpanded([]);
    setFormError(""); setSaveResult(false); setMode("form"); setFormFocus(value => value + 1);
    setWorkspaceFieldError("");
  };

  const saved = (task: ScheduledTaskSummary): void => {
    invalidateRead();
    const next = { ...draft, title: task.title }; draftBaseline.current = next;
    mergeTask(task); setPendingSave(null); setEditing(task); setDraft(next); setFormError(""); setWorkspaceFieldError(""); setSaveResult(true); void refreshLatest.current();
  };
  const save = async (): Promise<void> => {
    if (saveLock.current || saveResult) return;
    if (!pendingSave) {
      const problem = scheduleInputError(draft);
      if (problem) {
        if (draft.employeeId && !draft.workspaceId) { setWorkspaceFieldError(problem); setFormError(""); workspaceTrigger.current?.focus({ preventScroll: false }); }
        else setFormError(problem);
        return;
      }
      const employee = employeeData.employees.find(item => item.id === draft.employeeId);
      if (!employee || employee.archivedAt || !employee.agents.length) {
        setFormError("这位员工当前不可用，请选择另一位员工。"); return;
      }
      if (!workspaces.some(workspace => workspace.id === draft.workspaceId)) {
        setWorkspaceFieldError("这个工作区当前不可用，请选择已有的工作区。"); setFormError(""); workspaceTrigger.current?.focus({ preventScroll: false }); return;
      }
    }
    saveLock.current = true; setSaving(true); setFormError(""); setWorkspaceFieldError("");
    invalidateRead();
    const request = pendingSave ?? (editing ? { kind: "update" as const, id: editing.id, patch: {
      revision: editing.revision, employeeId: draft.employeeId, workspaceId: draft.workspaceId, prompt: draft.prompt, schedule: draft.schedule,
      title: draft.title?.trim() || draft.prompt.trim().split("\n")[0].slice(0, 80),
      ...(editing.schedule.kind === "once" && !editing.nextRunAt ? { enabled: true } : {}),
    } } : { kind: "create" as const, input: { ...draft } });
    try {
      const task = request.kind === "create" ? await scheduledTasksRepository.create(request.input)
        : await scheduledTasksRepository.update(request.id, request.patch);
      saved(task);
    } catch (cause) {
      if (request.kind === "update" && cause instanceof HttpResponseError && cause.status === 409) {
        try {
          const latest = await scheduledTasksRepository.detail(request.id);
          if (pendingSave && sameSavedInput(latest.task, request.patch)) { saved(latest.task); return; }
          setEditing(latest.task); mergeTask(latest.task); setPendingSave(null);
          setFormError("计划已在其他页面修改。已读取最新版本，你的输入仍保留；请核对后再次保存。");
        } catch { setFormError("计划版本已变化，暂时无法读取最新版本。你的输入仍保留，请稍后重试。"); }
      } else {
        const unknown = scheduleSaveUnknown(cause);
        setPendingSave(unknown ? request : null);
        setFormError(unknown ? "保存回执尚未确认。输入已保留，点击「确认保存结果」会核对同一次请求。" : errorText(cause));
      }
    } finally { saveLock.current = false; setSaving(false); }
  };

  const changeTask = async (task: ScheduledTaskSummary, patch: Pick<ScheduledTaskPatch, "enabled" | "cancelled">): Promise<void> => {
    if (busyTask) return;
    setBusyTask(task.id); setActionError("");
    invalidateRead();
    try {
      const updated = await scheduledTasksRepository.update(task.id, { revision: task.revision, ...patch });
      invalidateRead(); mergeTask(updated);
      // This page's own pause/resume changed only lifecycle fields. Keep its editor
      // revision current without replacing the separately held draft or bypassing remote conflicts.
      setEditing(previous => previous?.id === updated.id ? updated : previous);
      setCancelId("");
      if (viewRef.current === "calendar" && expandedRef.current.includes(task.id)) setExpanded([]);
      void refreshLatest.current();
    }
    catch (cause) {
      setActionError(cause instanceof HttpResponseError && cause.status === 409 ? "计划已在其他页面修改，请核对最新状态后重试。" : errorText(cause));
      void refreshLatest.current();
    } finally { setBusyTask(""); }
  };


  const counts = {
    all: tasks.length, active: tasks.filter(task => !task.cancelledAt && task.enabled && task.nextRunAt).length,
    paused: tasks.filter(task => !task.cancelledAt && !task.enabled && task.nextRunAt).length,
    finished: tasks.filter(task => task.cancelledAt || !task.nextRunAt).length,
  };
  const shown = tasks.filter(task => (filter === "all" || (filter === "finished" ? Boolean(task.cancelledAt || !task.nextRunAt)
    : filter === "paused" ? !task.cancelledAt && !task.enabled && Boolean(task.nextRunAt) : !task.cancelledAt && task.enabled && Boolean(task.nextRunAt)))
    && (!query.trim() || [task.title, task.prompt, task.employeeName, task.workspaceName].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const toggleRow = (id: string) => { setExpanded(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); setCancelId(""); };
  const busy = saving || !!busyTask || !!pendingSave;
  const renderActions = (task: ScheduledTaskSummary): React.ReactNode => <div className="scheduled-task-actions">
    {task.nextRunAt && !task.cancelledAt ? <Tooltip title={task.enabled ? "暂停计划（不停止当前执行）" : "恢复计划"}>
      <span className="scheduled-switch-hitbox"><Switch size="small" checked={task.enabled} aria-label={`${task.enabled ? "暂停" : "恢复"}${task.title}`}
        disabled={busy || !task.enabled && !!(task.employeeUnavailableReason || task.workspaceUnavailableReason)}
        loading={busyTask === task.id} onChange={enabled => void changeTask(task, { enabled })}/></span>
    </Tooltip> : <span className="scheduled-switch-placeholder" aria-hidden/>}
    <WandDropdownMenu open={menuId === task.id} onOpenChange={open => setMenuId(open ? task.id : "")}>
      <WandDropdownMenuTrigger render={<WandIconButton aria-label={`${task.title}的更多操作`} disabled={saving}><WandIcon name="more"/></WandIconButton>}/>
      <WandDropdownMenuContent align="end" popupOwner={`scheduled-actions-${task.id}`}>
        {task.lastRun?.sessionId && <WandDropdownMenuItem onSelect={() => onOpenSession(task.lastRun!.sessionId!)}>查看会话</WandDropdownMenuItem>}
        <WandDropdownMenuItem onSelect={() => setExpanded(previous => previous.includes(task.id) ? previous : [...previous, task.id])}>执行记录</WandDropdownMenuItem>
        {!task.cancelledAt && <><WandDropdownMenuItem disabled={busy} onSelect={() => { void edit(task); }}>编辑任务</WandDropdownMenuItem>
          {task.nextRunAt && <WandDropdownMenuItem disabled={busy || !task.enabled && !!(task.employeeUnavailableReason || task.workspaceUnavailableReason)} onSelect={() => void changeTask(task, { enabled: !task.enabled })}>{task.enabled ? "暂停计划" : "恢复计划"}</WandDropdownMenuItem>}
          <WandDropdownMenuItem disabled={busy} onSelect={() => { setExpanded(previous => previous.includes(task.id) ? previous : [...previous, task.id]); setCancelId(task.id); }}>取消计划</WandDropdownMenuItem></>}
      </WandDropdownMenuContent>
    </WandDropdownMenu>
  </div>;
  const renderDetails = (task: ScheduledTaskSummary, run?: ScheduledTaskRunFactView): React.ReactNode => <>
    <ScheduledTaskDetails task={task} active={visible && mode === "list" && expanded.includes(task.id) && cancelId !== task.id} focusRun={run} onEdit={() => void edit(task)} onOpenSession={onOpenSession}/>
    {cancelId === task.id && <div className="scheduled-inline-confirm" role="group" aria-label={`确认取消${task.title}`}>
      <p>保留历史和当前执行，只取消后续安排？</p>
      <WandButton kind="danger" size="small" loading={busyTask === task.id} disabled={!!busyTask} onClick={() => void changeTask(task, { cancelled: true })}>确认取消</WandButton>
      <WandButton size="small" disabled={!!busyTask} onClick={() => setCancelId("")}>保留计划</WandButton>
    </div>}
  </>;
  const pageTitle = "定时";
  return <ScheduledPresentationProvider employees={employeeData.employees} now={clock} timeZone={localZone}>
    <section ref={pageRef} className="scheduled-tasks-page" aria-label={pageTitle} hidden={!visible} inert={!visible} style={{ display: visible ? undefined : "none" }}>
      <Flex component="header" className="scheduled-tasks-header" align="center" justify="space-between" gap="small">
        <Flex className="scheduled-tasks-heading" align="center" gap="small">
          {onOpenSidebar ? <WandIconButton aria-label={sidebarOpen ? "关闭列表" : "打开列表"} onClick={onOpenSidebar}><SidebarToggleIcon open={!!sidebarOpen}/></WandIconButton> : null}
          <WandIconButton aria-label={mode === "form" ? `返回${pageTitle}` : "返回会话"} onClick={back} disabled={saving || !!busyTask}><WandIcon name="back"/></WandIconButton>
          <h1 ref={titleRef} tabIndex={-1}>{pageTitle}</h1>
          <span className="scheduled-global-scope-label">全部员工</span>
        </Flex>
        <WandButton kind="primary" className="scheduled-create-trigger" aria-label={mode === "form" ? "收起编辑" : "新建定时任务"} aria-expanded={mode === "form"} disabled={saving || !!busyTask}
          onClick={() => mode === "form" ? back() : void startNew()}><ConversationMorphIcon from="plus" to="close" active={mode === "form"}/><span className="scheduled-create-label">{mode === "form" ? "收起编辑" : "新建定时任务"}</span></WandButton>
      </Flex>
      <div className="scheduled-tasks-body"><div className="scheduled-tasks-content">
        <div className="scheduled-view-toolbar"><WandStretchTabs ariaLabel="日程视图" value={view}
          onValueChange={value => (onViewChange ?? setLocalView)(value as "list" | "calendar")}
          tabs={[{ value: "calendar", label: "日历" }, { value: "list", label: "定时任务" }]}/></div>
        {actionError && <Alert type="error" showIcon title={actionError} role="alert" closable onClose={() => setActionError("")}/>}
        {error && <Alert type="error" showIcon title={error} action={<WandButton size="small" onClick={() => void refresh()}>重新读取</WandButton>} role="alert"/>}
        {employeeData.error && <Alert type="warning" showIcon title="员工资料暂时无法读取，日程仍保留。头像使用公共回退显示。"/>}
        <div className="scheduled-editor-shell" data-open={mode === "form"} inert={mode !== "form"}><div>
          <section className="scheduled-editor" aria-label={editing ? "编辑定时任务" : "新建定时任务"}>
            <h2>{editing ? "编辑定时任务" : "新建定时任务"}</h2>
            <ScheduledTaskForm draft={draft} onChange={next => { setSaveResult(false); setFormError(""); setDraft(next); if (next.workspaceId !== draft.workspaceId) setWorkspaceFieldError(""); }} editing={editing} error={formError}
              visible={visible && mode === "form"} saving={saving} result={saveResult} unknown={!!pendingSave} backLabel={`返回${view === "calendar" ? "日历" : "列表"}`} employeeData={employeeData} localZone={localZone}
              workspaces={workspaces} workspaceLoading={!workspacesLoaded && loading} workspaceError={workspaceError} onReloadWorkspaces={() => void refresh()}
              workspaceFieldError={workspaceFieldError} workspaceTrigger={workspaceTrigger} onSave={() => void save()} onBack={back}/>
          </section>
        </div></div>
        <div className="scheduled-list-toolbar">
          <WandStretchTabs ariaLabel="定时任务筛选" value={filter} onValueChange={value => { setFilter(value as Filter); setExpanded([]); setCancelId(""); setMenuId(""); }}
            tabs={[{ value: "all", label: `全部 ${loaded ? counts.all : "—"}` }, { value: "active", label: `待执行 ${loaded ? counts.active : "—"}` }, { value: "paused", label: `已暂停 ${loaded ? counts.paused : "—"}` }, { value: "finished", label: `已结束 ${loaded ? counts.finished : "—"}` }]}/>
          <div className="scheduled-search-tools"><WandSearchField value={query} onValueChange={value => { setQuery(value); setExpanded([]); setCancelId(""); }} placeholder="搜索任务或员工" label="搜索定时任务"/>
            <Tooltip title="刷新"><WandIconButton aria-label="刷新定时任务" disabled={loading} onClick={() => void refresh()}><WandIcon name="refresh"/></WandIconButton></Tooltip></div>
        </div>
        <div className="scheduled-schedule-view-host">
          <div className="scheduled-schedule-view-pane" data-active={view === "calendar"} hidden={calendarHidden && view !== "calendar"} inert={view !== "calendar"} aria-hidden={view !== "calendar"}
            onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && view !== "calendar") setCalendarHidden(true); }}>
            {calendarVisited && <ScheduleCalendar tasks={shown} allTasks={tasks} feed={calendarFeed} loading={loading}
              mode={calendarMode ?? localCalendarMode} onModeChange={onCalendarModeChange ?? setLocalCalendarMode} onRangeChange={onRangeChange}
              active={visible && view === "calendar" && mode === "list"} selectedTaskId={expanded[0] ?? null} onSelectTask={selectCalendarTask} renderDetails={renderDetails} renderActions={renderActions}/>}
          </div>
          <div className="scheduled-schedule-view-pane scheduled-list-pane" data-active={view === "list"} hidden={listHidden && view !== "list"} inert={view !== "list"} aria-hidden={view !== "list"}
            onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && view !== "list") setListHidden(true); }}>
            <NextTaskPanel task={nextTask(tasks)} scene={!loaded && error ? "error" : !loaded && loading ? "loading" : "normal"}
              hasTasks={!!tasks.length} reduced={reduced} onLocate={task => { setExpanded(previous => previous.includes(task.id) ? previous : [...previous, task.id]); }} onEdit={task => void edit(task)}/>
            {!loaded && loading && <div role="status" className="scheduled-read-state"><Spin size="small"/>正在读取定时任务…</div>}
            {loaded && !shown.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tasks.length ? "没有匹配的定时任务。" : "还没有定时任务。"}/> : <TaskAgenda tasks={shown} expanded={expanded} visited={visited} onToggle={toggleRow} renderActions={renderActions} renderDetails={renderDetails}/>}
          </div>
        </div>
        <footer className="scheduled-page-foot"><span className="scheduled-rule-note">每次执行独立创建会话；暂停或取消不停止当前执行。服务需保持运行。</span><span>{localZone}</span></footer>
      </div></div>
    </section>
  </ScheduledPresentationProvider>;
}

function ScheduledTaskForm({ draft, onChange, editing, error, visible, saving, result, unknown, backLabel, employeeData, workspaces, workspaceLoading, workspaceError, workspaceFieldError, workspaceTrigger, onReloadWorkspaces, localZone, onSave, onBack }: {
  draft: ScheduledTaskInput; onChange(next: ScheduledTaskInput): void; editing: ScheduledTaskSummary | null; error: string;
  visible: boolean; saving: boolean; result: boolean; unknown: boolean; backLabel: string; employeeData: ReturnType<typeof useSiliconEmployees>; localZone: string;
  workspaces: Workspace[]; workspaceLoading: boolean; workspaceError: string; onReloadWorkspaces(): void;
  workspaceFieldError: string; workspaceTrigger: React.RefObject<HTMLButtonElement | null>;
  onSave(): void; onBack(): void;
}): React.ReactElement {
  const disabled = saving || unknown || !visible;
  const [dateOpen, setDateOpen] = React.useState(false);
  const [timeOpen, setTimeOpen] = React.useState(false);
  const dateRef = React.useRef<React.ComponentRef<typeof DatePicker>>(null);
  const timeRef = React.useRef<React.ComponentRef<typeof TimePicker>>(null);
  usePopupDismiss(dateOpen, () => { setDateOpen(false); dateRef.current?.focus(); });
  usePopupDismiss(timeOpen, () => { setTimeOpen(false); timeRef.current?.focus(); });
  React.useEffect(() => { if (!visible) { setDateOpen(false); setTimeOpen(false); } }, [visible]);
  const zones = React.useMemo(scheduleTimeZones, []);
  const selected = employeeData.employees.find(employee => employee.id === draft.employeeId);
  const options = employeeData.employees.map(employee => ({ value: employee.id,
    label: `${employee.name}${employee.archivedAt ? "（已归档）" : !employee.agents.length ? "（未配置执行工具）" : ""}`,
    disabled: !!employee.archivedAt || !employee.agents.length,
  }));
  if (draft.employeeId && !selected) options.unshift({ value: draft.employeeId, label: `${editing?.employeeName || "原员工"}（当前不可用）`, disabled: true });
  const selectedWorkspace = workspaces.find(workspace => workspace.id === draft.workspaceId);
  const workspaceOptions = workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }));
  if (draft.workspaceId && !selectedWorkspace) workspaceOptions.unshift({ value: draft.workspaceId, label: `${editing?.workspaceName || "原工作区"}（当前不可用）` });
  const workspaceCwd = selectedWorkspace?.cwd ?? (editing?.workspaceId === draft.workspaceId ? editing?.workspaceCwd : null);
  const changePlan = (schedule: TaskSchedule): void => onChange({ ...draft, schedule });
  const changeKind = (value: string): void => {
    if (value === "once") changePlan({ kind: "once", runAt: dayjs().add(1, "hour").startOf("minute").toISOString() });
    else if (value === "interval") changePlan({ kind: "interval", everyHours: 3,
      startAt: dayjs().add(1, "hour").startOf("minute").toISOString(), timeZone: localZone });
    else {
      const base = draft.schedule.kind === "once" || draft.schedule.kind === "interval" ? { time: "09:00", timeZone: localZone } : draft.schedule;
      changePlan(value === "weekly" ? { kind: "weekly", time: base.time, timeZone: base.timeZone, weekday: draft.schedule.kind === "weekly" ? draft.schedule.weekday : 1 }
        : { kind: "daily", time: base.time, timeZone: base.timeZone });
    }
  };
  let preview = "请完善执行计划";
  try {
    const next = nextScheduledTime(parseTaskSchedule(draft.schedule), new Date());
    const zone = draft.schedule.kind === "once" ? localZone : draft.schedule.timeZone;
    preview = next ? `下次执行：${scheduleDateInZone(next, zone)}` : "执行时间已过去";
  } catch { /* Incomplete fields remain editable. */ }
  return <Form layout="vertical" noValidate className="scheduled-task-form" onFinish={onSave}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>员工会按照自己的工具与模型配置执行提示词。每次执行都会保留对话记录。</Typography.Paragraph>
    {employeeData.error ? <Alert type="error" showIcon title={`员工列表读取失败：${employeeData.error}`} action={<WandButton size="small" onClick={employeeData.reload}>重试</WandButton>}/> : null}
    {workspaceError ? <Alert type="error" showIcon title={`工作区读取失败：${workspaceError}`} action={<WandButton size="small" onClick={onReloadWorkspaces}>重试</WandButton>}/> : null}
    {error ? <Alert type={unknown ? "warning" : "error"} showIcon title={error} role="alert"/> : null}
    <Form.Item label="任务名称（可选）" htmlFor="scheduled-task-name"><Input id="scheduled-task-name" value={draft.title ?? ""} maxLength={200} disabled={disabled} placeholder="留空时使用提示词首行" onChange={event => onChange({ ...draft, title: event.target.value })}/></Form.Item>
    <Form.Item label="执行员工" required help={editing?.employeeUnavailableReason || "使用这位员工当前的工具与模型配置。"}>
      <WandSelect ariaLabel="执行员工" placeholder={employeeData.loading ? "正在读取员工…" : "选择一位员工"}
        value={draft.employeeId || undefined} options={options} searchable searchPlaceholder="搜索员工"
        disabled={disabled || employeeData.loading} popupOwner="scheduled-task-form"
        onValueChange={employeeId => onChange({ ...draft, employeeId })}/>
    </Form.Item>
    <Form.Item label="执行工作区" required htmlFor="scheduled-task-workspace" validateStatus={workspaceFieldError ? "error" : undefined}
      help={<span id="scheduled-task-workspace-help">{workspaceFieldError || (!workspaceLoading && !workspaces.length && !workspaceError ? "还没有配置工作区。请先在工作区页面创建项目，再返回选择。" : "使用所选工作区的目录执行任务。")}</span>}>
      <WandSelect ariaLabel="执行工作区" placeholder={workspaceLoading ? "正在读取工作区…" : "选择一个已有工作区"}
        id="scheduled-task-workspace" triggerRef={workspaceTrigger} aria-describedby="scheduled-task-workspace-help" aria-invalid={workspaceFieldError ? true : undefined}
        value={draft.workspaceId || undefined} options={workspaceOptions.map(option => ({ ...option, disabled: !workspaces.some(workspace => workspace.id === option.value) }))}
        searchable searchPlaceholder="搜索工作区" disabled={disabled || workspaceLoading} popupOwner="scheduled-task-form"
        onValueChange={workspaceId => onChange({ ...draft, workspaceId })}/>
      {workspaceCwd ? <div className="scheduled-task-directory" role="status"><Typography.Text type="secondary">执行目录</Typography.Text><Typography.Text code>{workspaceCwd}</Typography.Text></div> : null}
      {!draft.workspaceId && editing?.workspaceCwd ? <div className="scheduled-task-directory"><Typography.Text type="secondary">原计划使用服务默认目录，请选择工作区</Typography.Text><Typography.Text code>{editing.workspaceCwd}</Typography.Text></div> : null}
      {draft.workspaceId && !selectedWorkspace && !workspaceLoading ? <Typography.Text type="danger">{editing?.workspaceUnavailableReason || "原工作区当前不可用，请重新选择。"}</Typography.Text> : null}
    </Form.Item>
    <Form.Item label="执行提示词" htmlFor="scheduled-task-prompt" required help="可以直接粘贴帖子或完整任务要求，保存后会按这段提示词执行。">
      <Input.TextArea id="scheduled-task-prompt" aria-label="执行提示词" className="scheduled-task-prompt" autoSize={{ minRows: 4, maxRows: 18 }}
        placeholder="例如：阅读下面这段帖子，整理重点并给出我的行动建议。" value={draft.prompt} disabled={disabled}
        onChange={event => onChange({ ...draft, prompt: event.target.value })}/>
    </Form.Item>
    <div className="scheduled-task-plan-grid">
      <Form.Item label="执行计划" required><WandSelect ariaLabel="执行计划" value={draft.schedule.kind} disabled={disabled}
        options={[{ value: "once", label: "指定时间执行一次" }, { value: "interval", label: "每隔若干小时" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }]}
        popupOwner="scheduled-task-form" onValueChange={changeKind}/></Form.Item>
      {draft.schedule.kind === "once" ? <Form.Item label="执行日期和时间" required help={`按本机时区 ${localZone} 显示。`}>
        <DatePicker ref={dateRef} aria-label="执行日期和时间" value={draft.schedule.runAt ? dayjs(draft.schedule.runAt) : null}
          classNames={{ popup: { root: "scheduled-task-date-popup" } }}
          showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" disabled={disabled} open={dateOpen} onOpenChange={setDateOpen}
          onChange={value => changePlan({ kind: "once", runAt: value?.toISOString() || "" })}
          panelRender={panel => <div data-wand-popup-owner="scheduled-task-form">{panel}</div>}/>
      </Form.Item> : <>
        {draft.schedule.kind === "interval" ? <>
          <Form.Item label="间隔小时数" required help="1–8760 的整数；每小时填 1，每3小时填 3。">
            <InputNumber aria-label="间隔小时数" min={1} max={8760} precision={0} value={draft.schedule.everyHours} disabled={disabled}
              onChange={value => { if (draft.schedule.kind === "interval") changePlan({ ...draft.schedule, everyHours: value ?? 0 }); }}/>
          </Form.Item>
          <Form.Item label="首次执行时间" required help={`按本机时区 ${localZone} 编辑；下方预览按所选时区显示。`}>
            <DatePicker classNames={{ popup: { root: "scheduled-task-date-popup" } }} ref={dateRef} aria-label="首次执行时间" value={draft.schedule.startAt ? dayjs(draft.schedule.startAt) : null}
              showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" disabled={disabled} open={dateOpen} onOpenChange={setDateOpen}
              onChange={value => { if (draft.schedule.kind === "interval") changePlan({ ...draft.schedule, startAt: value?.toISOString() || "" }); }}
              panelRender={panel => <div data-wand-popup-owner="scheduled-task-form">{panel}</div>}/>
          </Form.Item>
        </> : <Form.Item label="执行时间" required><TimePicker ref={timeRef} aria-label="执行时间" format="HH:mm"
          value={draft.schedule.time ? dayjs(`2000-01-01T${draft.schedule.time}`) : null} disabled={disabled}
          open={timeOpen} onOpenChange={setTimeOpen} needConfirm={false}
          onChange={value => { if (draft.schedule.kind === "daily" || draft.schedule.kind === "weekly") changePlan({ ...draft.schedule, time: value?.format("HH:mm") || "" }); }}
          panelRender={panel => <div data-wand-popup-owner="scheduled-task-form">{panel}</div>}/></Form.Item>}
        {draft.schedule.kind === "weekly" ? <Form.Item label="星期" required><WandSelect ariaLabel="执行星期" value={String(draft.schedule.weekday)} disabled={disabled}
          options={[1, 2, 3, 4, 5, 6, 0].map(weekday => ({ value: String(weekday), label: WEEKDAYS[weekday] }))}
          popupOwner="scheduled-task-form" onValueChange={weekday => { if (draft.schedule.kind === "weekly") changePlan({ ...draft.schedule, weekday: Number(weekday) }); }}/></Form.Item> : null}
        <Form.Item label="时区" required><WandSelect ariaLabel="执行时区" value={draft.schedule.timeZone} options={zones} searchable searchPlaceholder="搜索时区"
          disabled={disabled} popupOwner="scheduled-task-form" onValueChange={timeZone => { if (draft.schedule.kind !== "once") changePlan({ ...draft.schedule, timeZone }); }}/></Form.Item>
      </>}
    </div>
    <div role="status" aria-label="执行计划预览"><Typography.Paragraph>{scheduleLabel(draft.schedule)}</Typography.Paragraph>
      <Typography.Paragraph>{preview}</Typography.Paragraph>
      {draft.schedule.kind === "interval" ? <Typography.Paragraph type="secondary">从首次执行时间起按固定小时数重复，跨夏令时仍保持间隔。首次时间已过去时，从下个周期开始。暂停后恢复沿用原时间锚点；服务停机漏期合并补跑一次，上次未结束则跳过本次。</Typography.Paragraph> : null}
    </div>
    <Flex gap="small" className="scheduled-task-form-actions"><WandButton className="scheduled-task-save" kind="primary" type="submit" loading={saving} disabled={saving || result || !unknown && (employeeData.loading || !!employeeData.error || workspaceLoading || !!workspaceError)}>
      {saving ? "正在保存…" : result ? "已保存" : unknown ? "确认保存结果" : editing?.schedule.kind === "once" && !editing.nextRunAt ? "保存并重新安排" : editing ? "保存修改" : "创建定时任务"}</WandButton>
      <WandButton disabled={saving} onClick={onBack}>{backLabel}</WandButton></Flex>
  </Form>;
}
