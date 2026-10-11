import * as React from "react";
import { Alert, DatePicker, Empty, Flex, Form, Input, Spin, Tag, TimePicker, Typography } from "antd";
import dayjs from "dayjs";
import type { ScheduledTaskDetail, ScheduledTaskInput, ScheduledTaskSummary, TaskSchedule } from "../../../scheduled-task-types.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { createRequestId, HttpResponseError } from "../http-adapter.js";
import { installStyleSheet } from "../styles";
import { confirmDiscardTaskDraft } from "../task-draft-guard";
import { httpWorkspacesRepository } from "../workspaces/repository";
import type { Workspace } from "../workspaces/types";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { WandButton, WandIcon, WandIconButton, WandSelect, WandStretchTabs } from "../ui";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { scheduleDate, scheduleInputError, scheduleLabel, scheduleSaveUnknown, scheduleTimeZones, scheduledRunState, scheduledTaskState, WEEKDAYS } from "./model";
import { scheduledTasksRepository, type ScheduledTaskPatch } from "./repository";
import { scheduledTaskStyles } from "./styles";

if (typeof document !== "undefined") installStyleSheet("wand-scheduled-task-styles", scheduledTaskStyles);

export interface ScheduledTasksPageProps {
  visible: boolean;
  sidebarOpen?: boolean;
  onBack(): void;
  onOpenSidebar?(): void;
  onOpenSession(id: string): void;
}

type Filter = "all" | "active" | "paused" | "finished";
type PendingSave = { kind: "create"; input: ScheduledTaskInput } | { kind: "update"; id: string; patch: ScheduledTaskPatch };

function newDraft(): ScheduledTaskInput {
  return { requestId: createRequestId(), employeeId: "", workspaceId: "", prompt: "",
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
export function ScheduledTasksPage({ visible, sidebarOpen, onBack, onOpenSidebar, onOpenSession }: ScheduledTasksPageProps): React.ReactElement {
  const [tasks, setTasks] = React.useState<ScheduledTaskSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [mode, setMode] = React.useState<"list" | "form" | "history">("list");
  const [editing, setEditing] = React.useState<ScheduledTaskSummary | null>(null);
  const [draft, setDraft] = React.useState<ScheduledTaskInput>(newDraft);
  const draftBaseline = React.useRef(draft);
  const draftSwitchLock = React.useRef(false);
  const [formError, setFormError] = React.useState("");
  const [workspaceFieldError, setWorkspaceFieldError] = React.useState("");
  const workspaceTrigger = React.useRef<HTMLButtonElement>(null);
  const [pendingSave, setPendingSave] = React.useState<PendingSave | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [busyTask, setBusyTask] = React.useState("");
  const [cancelId, setCancelId] = React.useState("");
  const [historyId, setHistoryId] = React.useState("");
  const [detail, setDetail] = React.useState<ScheduledTaskDetail | null>(null);
  const [documentVisible, setDocumentVisible] = React.useState(() => document.visibilityState !== "hidden");
  const loadRef = React.useRef<AbortController | null>(null);
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
    if (!visible || !documentVisible || loadRef.current) return;
    const controller = new AbortController(); loadRef.current = controller;
    setLoading(true);
    try {
      const [taskResult, workspaceResult] = await Promise.allSettled([
        scheduledTasksRepository.list(controller.signal), httpWorkspacesRepository.list(),
      ]);
      if (controller.signal.aborted) return;
      if (taskResult.status === "fulfilled") { setTasks(taskResult.value); setLoaded(true); setError(""); }
      else setError(errorText(taskResult.reason));
      if (workspaceResult.status === "fulfilled") {
        setWorkspaces(workspaceResult.value.filter(workspace => workspace.kind !== "global" && workspace.id !== "wand-global" && !!workspace.cwd?.trim()));
        setWorkspacesLoaded(true); setWorkspaceError("");
      } else setWorkspaceError(errorText(workspaceResult.reason));
      if (mode === "history" && historyId) {
        const next = await scheduledTasksRepository.detail(historyId, controller.signal);
        if (!controller.signal.aborted) setDetail(next);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally { if (loadRef.current === controller) { loadRef.current = null; setLoading(false); } }
  }, [visible, documentVisible, mode, historyId]);

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
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault(); back();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [visible, back]);

  React.useEffect(() => {
    if (visible) titleRef.current?.focus({ preventScroll: true });
  }, [visible, mode]);

  const mergeTask = (task: ScheduledTaskSummary): void => {
    setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)]);
    setDetail(previous => previous?.task.id === task.id ? { ...previous, task } : previous);
  };

  const draftDirty = (): boolean => draft.employeeId !== draftBaseline.current.employeeId || draft.workspaceId !== draftBaseline.current.workspaceId || draft.prompt !== draftBaseline.current.prompt
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
    setFormError(""); setMode("form");
    setWorkspaceFieldError("");
  };
  const edit = async (task: ScheduledTaskSummary): Promise<void> => {
    if (pendingSave) { setMode("form"); return; }
    if (editing?.id === task.id) { setMode("form"); return; }
    if (!await discardBeforeSwitch()) return;
    const next = { requestId: createRequestId(), employeeId: task.employeeId, workspaceId: task.workspaceId ?? "", prompt: task.prompt, schedule: task.schedule };
    draftBaseline.current = next; setEditing(task); setDraft(next);
    setFormError(""); setMode("form");
    setWorkspaceFieldError("");
  };

  const saved = (task: ScheduledTaskSummary): void => {
    invalidateRead();
    const next = newDraft(); draftBaseline.current = next;
    mergeTask(task); setPendingSave(null); setEditing(null); setDraft(next); setFormError(""); setWorkspaceFieldError(""); setMode("list");
  };
  const save = async (): Promise<void> => {
    if (saveLock.current) return;
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
      title: draft.prompt.trim().split("\n")[0].slice(0, 80),
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
    try { const updated = await scheduledTasksRepository.update(task.id, { revision: task.revision, ...patch }); invalidateRead(); mergeTask(updated); setCancelId(""); }
    catch (cause) {
      setActionError(cause instanceof HttpResponseError && cause.status === 409 ? "计划已在其他页面修改，请核对最新状态后重试。" : errorText(cause));
      void refresh();
    } finally { setBusyTask(""); }
  };

  const history = (task: ScheduledTaskSummary): void => { setHistoryId(task.id); setDetail(null); setMode("history"); };
  const shown = tasks.filter(task => filter === "all" || (filter === "finished" ? Boolean(task.cancelledAt || !task.nextRunAt)
    : filter === "paused" ? !task.cancelledAt && !task.enabled && Boolean(task.nextRunAt) : !task.cancelledAt && task.enabled && Boolean(task.nextRunAt)));
  const pageTitle = mode === "form" ? editing ? "编辑定时任务" : "新建定时任务" : mode === "history" ? "执行记录" : "定时任务";
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return <section className="scheduled-tasks-page" aria-label="定时任务" hidden={!visible} inert={!visible} style={{ display: visible ? undefined : "none" }}>
    <Flex component="header" className="scheduled-tasks-header" align="center" justify="space-between" gap="small">
      <Flex align="center" gap="small">
        {onOpenSidebar ? <WandIconButton aria-label={sidebarOpen ? "关闭列表" : "打开列表"} onClick={onOpenSidebar}><SidebarToggleIcon open={!!sidebarOpen}/></WandIconButton> : null}
        <WandIconButton aria-label={mode === "list" ? "返回会话" : "返回定时任务"} onClick={back} disabled={saving || !!busyTask}><WandIcon name="back"/></WandIconButton>
        <h1 ref={titleRef} tabIndex={-1}>{pageTitle}</h1>
      </Flex>
      {mode === "list" ? <WandButton kind="primary" onClick={startNew}><WandIcon name="plus" size={16}/>新建定时任务</WandButton> : null}
    </Flex>
    <div className="scheduled-tasks-body"><div className="scheduled-tasks-content">
      {mode === "list" ? <>
        <Typography.Paragraph type="secondary" className="scheduled-tasks-intro">选择员工和工作区、写好提示词，Wand 会在指定时间自动执行。每次执行都会创建独立会话，显示在所选工作区的会话列表中。服务需要保持运行。</Typography.Paragraph>
        <Flex justify="space-between" align="center" gap="small" className="scheduled-tasks-tools">
          <WandStretchTabs ariaLabel="定时任务筛选" value={filter} onValueChange={value => setFilter(value as Filter)}
            tabs={[{ value: "all", label: "全部" }, { value: "active", label: "待执行" }, { value: "paused", label: "已暂停" }, { value: "finished", label: "已结束" }]}/>
          <WandButton kind="ghost" size="small" disabled={loading} onClick={() => void refresh()}><WandIcon name="refresh" size={14}/>刷新</WandButton>
        </Flex>
        {actionError ? <Alert type="error" showIcon title={actionError} role="alert"/> : null}
        {error ? <Alert type="error" showIcon title={error} action={<WandButton size="small" onClick={() => void refresh()}>重新读取</WandButton>} role="alert"/> : null}
        {!loaded && loading ? <Flex gap="small" align="center" role="status"><Spin size="small"/>正在读取定时任务…</Flex> : null}
        {loaded && !shown.length ? <Empty className="scheduled-task-empty" image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={tasks.length ? "这个筛选下还没有定时任务。" : "还没有定时任务。先选择一位员工，把想让它执行的内容写进去。"}/> : null}
        <div className="scheduled-task-list">{shown.map(task => <div className="scheduled-task-row" key={task.id} data-scheduled-task-id={task.id}>
          <div className="scheduled-task-main"><span className="scheduled-task-title">{task.title}</span>
            <p className="scheduled-task-preview">{task.prompt}</p>
            <Flex className="scheduled-task-meta" align="center"><Typography.Text>{task.employeeName}</Typography.Text><Tag>{scheduledTaskState(task)}</Tag></Flex>
            <div className="scheduled-task-directory"><Typography.Text type="secondary">{task.workspaceName}</Typography.Text><Typography.Text code>{task.workspaceCwd || "目录不可用"}</Typography.Text></div>
            {task.employeeUnavailableReason && !task.cancelledAt ? <Typography.Text type="danger">{task.employeeUnavailableReason}</Typography.Text> : null}
            {task.workspaceUnavailableReason && !task.cancelledAt ? <Typography.Text type="danger">{task.workspaceUnavailableReason}</Typography.Text> : null}
          </div>
          <div className="scheduled-task-timing"><Typography.Text>{scheduleLabel(task.schedule)}</Typography.Text>
            <Typography.Text type="secondary" className="scheduled-task-time">{task.nextRunAt && !task.cancelledAt ? `下次：${scheduleDate(task.nextRunAt)}` : task.cancelledAt ? "不再安排执行" : "暂无下次执行"}</Typography.Text>
            {task.lastRun ? <Typography.Text type="secondary">最近：{scheduledRunState(task.lastRun)}</Typography.Text> : null}
          </div>
          <Flex gap={4} className="scheduled-task-actions">
            {task.lastRun?.sessionId ? <WandButton size="small" onClick={() => onOpenSession(task.lastRun!.sessionId!)}>查看会话</WandButton> : null}
            <WandButton size="small" onClick={() => history(task)}>执行记录</WandButton>
            {!task.cancelledAt ? <><WandButton size="small" disabled={!!busyTask || !!pendingSave} onClick={() => edit(task)}>编辑</WandButton>
              {task.nextRunAt ? <WandButton size="small" disabled={!!busyTask || !task.enabled && !!(task.employeeUnavailableReason || task.workspaceUnavailableReason)}
                onClick={() => void changeTask(task, { enabled: !task.enabled })}>{busyTask === task.id ? "处理中…" : task.enabled ? "暂停" : "恢复"}</WandButton> : null}
              {cancelId === task.id ? <><Typography.Text type="secondary">保留执行记录，停止后续计划？</Typography.Text><WandButton size="small" kind="danger" disabled={!!busyTask} onClick={() => void changeTask(task, { cancelled: true })}>确认取消</WandButton><WandButton size="small" disabled={!!busyTask} onClick={() => setCancelId("")}>保留计划</WandButton></>
                : <WandButton size="small" kind="ghost" disabled={!!busyTask} onClick={() => setCancelId(task.id)}>取消计划</WandButton>}
            </> : null}
          </Flex>
        </div>)}</div>
      </> : mode === "form" ? <ScheduledTaskForm draft={draft} onChange={next => { setDraft(next); if (next.workspaceId !== draft.workspaceId) setWorkspaceFieldError(""); }} editing={editing} error={formError}
        visible={visible} saving={saving} unknown={!!pendingSave} employeeData={employeeData} localZone={localZone}
        workspaces={workspaces} workspaceLoading={!workspacesLoaded && loading} workspaceError={workspaceError} onReloadWorkspaces={() => void refresh()}
        workspaceFieldError={workspaceFieldError} workspaceTrigger={workspaceTrigger}
        onSave={() => void save()} onBack={back}/>
      : <>
        {error ? <Alert type="error" showIcon title={error} action={<WandButton size="small" onClick={() => void refresh()}>重新读取</WandButton>}/> : null}
        {!detail ? <Flex align="center" gap="small" role="status"><Spin size="small"/>正在读取执行记录…</Flex> : <>
          <Typography.Title level={4} className="scheduled-task-history-heading">{detail.task.title}</Typography.Title>
          <Typography.Paragraph type="secondary">{detail.task.employeeName} · {scheduleLabel(detail.task.schedule)}</Typography.Paragraph>
          <div className="scheduled-task-directory"><Typography.Text type="secondary">{detail.task.workspaceName}</Typography.Text><Typography.Text code>{detail.task.workspaceCwd || "目录不可用"}</Typography.Text></div>
          <details style={{ marginBottom: 24 }}><summary>查看提示词</summary><p className="scheduled-task-prompt-detail">{detail.task.prompt}</p></details>
          {!detail.runs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有执行记录。到达计划时间后会显示在这里。"/> : detail.runs.map(run => <div key={run.id} className="scheduled-task-run">
            <Flex justify="space-between" align="center" gap="small" wrap><Flex align="center" gap="small" wrap><Typography.Text className="scheduled-task-time">{scheduleDate(run.scheduledAt)}</Typography.Text><Tag>{scheduledRunState(run)}</Tag></Flex>
              {run.sessionId ? <WandButton size="small" onClick={() => onOpenSession(run.sessionId!)}>查看会话</WandButton> : null}</Flex>
            <div className="scheduled-task-directory"><Typography.Text type="secondary">执行目录</Typography.Text><Typography.Text code>{run.cwd || (run.cwd === undefined ? "旧记录未保留目录" : "未解析执行目录")}</Typography.Text></div>
            {run.error ? <Typography.Paragraph type={run.executionStatus === "skipped" ? "secondary" : "danger"} className="scheduled-task-run-error">{run.error}</Typography.Paragraph> : null}
          </div>)}
        </>}
      </>}
    </div></div>
  </section>;
}

function ScheduledTaskForm({ draft, onChange, editing, error, visible, saving, unknown, employeeData, workspaces, workspaceLoading, workspaceError, workspaceFieldError, workspaceTrigger, onReloadWorkspaces, localZone, onSave, onBack }: {
  draft: ScheduledTaskInput; onChange(next: ScheduledTaskInput): void; editing: ScheduledTaskSummary | null; error: string;
  visible: boolean; saving: boolean; unknown: boolean; employeeData: ReturnType<typeof useSiliconEmployees>; localZone: string;
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
    else {
      const base = draft.schedule.kind === "once" ? { time: "09:00", timeZone: localZone } : draft.schedule;
      changePlan(value === "weekly" ? { kind: "weekly", time: base.time, timeZone: base.timeZone, weekday: draft.schedule.kind === "weekly" ? draft.schedule.weekday : 1 }
        : { kind: "daily", time: base.time, timeZone: base.timeZone });
    }
  };
  return <Form layout="vertical" noValidate className="scheduled-task-form" onFinish={onSave}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>员工会按照自己的工具与模型配置执行提示词。每次执行都会保留对话记录。</Typography.Paragraph>
    {employeeData.error ? <Alert type="error" showIcon title={`员工列表读取失败：${employeeData.error}`} action={<WandButton size="small" onClick={employeeData.reload}>重试</WandButton>}/> : null}
    {workspaceError ? <Alert type="error" showIcon title={`工作区读取失败：${workspaceError}`} action={<WandButton size="small" onClick={onReloadWorkspaces}>重试</WandButton>}/> : null}
    {error ? <Alert type={unknown ? "warning" : "error"} showIcon title={error} role="alert"/> : null}
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
      <Input.TextArea id="scheduled-task-prompt" aria-label="执行提示词" className="scheduled-task-prompt" autoSize={{ minRows: 7, maxRows: 18 }}
        placeholder="例如：阅读下面这段帖子，整理重点并给出我的行动建议。" value={draft.prompt} disabled={disabled}
        onChange={event => onChange({ ...draft, prompt: event.target.value })}/>
    </Form.Item>
    <div className="scheduled-task-plan-grid">
      <Form.Item label="执行计划" required><WandSelect ariaLabel="执行计划" value={draft.schedule.kind} disabled={disabled}
        options={[{ value: "once", label: "指定时间执行一次" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }]}
        popupOwner="scheduled-task-form" onValueChange={changeKind}/></Form.Item>
      {draft.schedule.kind === "once" ? <Form.Item label="执行日期和时间" required help={`按本机时区 ${localZone} 显示。`}>
        <DatePicker ref={dateRef} aria-label="执行日期和时间" value={draft.schedule.runAt ? dayjs(draft.schedule.runAt) : null}
          classNames={{ popup: { root: "scheduled-task-date-popup" } }}
          showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" disabled={disabled} open={dateOpen} onOpenChange={setDateOpen}
          onChange={value => changePlan({ kind: "once", runAt: value?.toISOString() || "" })}
          panelRender={panel => <div data-wand-popup-owner="scheduled-task-form">{panel}</div>}/>
      </Form.Item> : <>
        <Form.Item label="执行时间" required><TimePicker ref={timeRef} aria-label="执行时间" format="HH:mm"
          value={draft.schedule.time ? dayjs(`2000-01-01T${draft.schedule.time}`) : null} disabled={disabled}
          open={timeOpen} onOpenChange={setTimeOpen} needConfirm={false}
          onChange={value => { if (draft.schedule.kind !== "once") changePlan({ ...draft.schedule, time: value?.format("HH:mm") || "" }); }}
          panelRender={panel => <div data-wand-popup-owner="scheduled-task-form">{panel}</div>}/></Form.Item>
        {draft.schedule.kind === "weekly" ? <Form.Item label="星期" required><WandSelect ariaLabel="执行星期" value={String(draft.schedule.weekday)} disabled={disabled}
          options={[1, 2, 3, 4, 5, 6, 0].map(weekday => ({ value: String(weekday), label: WEEKDAYS[weekday] }))}
          popupOwner="scheduled-task-form" onValueChange={weekday => { if (draft.schedule.kind === "weekly") changePlan({ ...draft.schedule, weekday: Number(weekday) }); }}/></Form.Item> : null}
        <Form.Item label="时区" required><WandSelect ariaLabel="执行时区" value={draft.schedule.timeZone} options={zones} searchable searchPlaceholder="搜索时区"
          disabled={disabled} popupOwner="scheduled-task-form" onValueChange={timeZone => { if (draft.schedule.kind !== "once") changePlan({ ...draft.schedule, timeZone }); }}/></Form.Item>
      </>}
    </div>
    <Flex gap="small" className="scheduled-task-form-actions"><WandButton kind="primary" type="submit" disabled={saving || !unknown && (employeeData.loading || !!employeeData.error || workspaceLoading || !!workspaceError)}>
      {saving ? "正在保存…" : unknown ? "确认保存结果" : editing?.schedule.kind === "once" && !editing.nextRunAt ? "保存并重新安排" : editing ? "保存修改" : "创建定时任务"}</WandButton>
      <WandButton disabled={saving} onClick={onBack}>返回列表</WandButton></Flex>
  </Form>;
}
