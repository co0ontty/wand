import * as React from "react";
import { createRoot } from "react-dom/client";
import { Alert, DatePicker, Empty, Form, Input, Skeleton, Switch, TimePicker, Tooltip } from "antd";
import dayjs from "dayjs";
import type { ScheduledTaskInput, ScheduledTaskRunView, ScheduledTaskSummary } from "../../../src/scheduled-task-types.js";
import { nextScheduledTime } from "../../../src/scheduled-task-time.js";
import { scheduleInputError, scheduleLabel, scheduleTimeZones, WEEKDAYS } from "../../../src/web-ui/react/scheduled-tasks/model.js";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { setWandTheme, wandThemeStore } from "../../../src/web-ui/react/theme-preference";
import type { WandThemeId } from "../../../src/web-ui/react/theme-palettes";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon, type WandIconName } from "../../../src/web-ui/react/ui/icons";
import { WandBrandMark } from "../../../src/web-ui/react/ui/brand-mark";
import { WandSearchField } from "../../../src/web-ui/react/ui/search-field";
import { WandInput } from "../../../src/web-ui/react/ui/input";
import { WandSelect } from "../../../src/web-ui/react/ui/select";
import { WandStretchTabs } from "../../../src/web-ui/react/ui/stretch-tabs";
import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem } from "../../../src/web-ui/react/ui/dropdown-menu";
import { hasOpenPopupSurface, usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import { ConversationMorphIcon } from "../../../src/web-ui/react/conversations/controls";
import { MOTION_DWELL_SENT_MS, useReducedMotion } from "../../../src/web-ui/react/ui/motion-tokens";
import { DISPLAY_ZONE, PREVIEW_NOW, employees, histories, initialTasks, workspaces } from "./fixtures";
import { nextTask } from "./agenda-model";
import { NextTaskPanel, TaskAgenda } from "./agenda-view";
import { ExecutionHistory } from "./execution-history";
import { ScheduleCalendar } from "./calendar-view";
import "./style.css";

installReactUiStyles();
type Filter = "all" | "active" | "paused" | "finished";
type Layout = "list" | "calendar";
const INITIAL_LAYOUT: Layout = new URLSearchParams(location.search).get("layout") === "calendar" ? "calendar" : "list";
type Scene = "normal" | "empty" | "loading" | "error" | "refresh-error";
type Phase = "idle" | "saving" | "sent" | "result";
const clone = <T,>(value: T): T => structuredClone(value);
const formatDate = (value: string, timeOnly = false) => new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_ZONE, ...(timeOnly ? {} : { month: "2-digit", day: "2-digit" }), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
const matchesFilter = (task: ScheduledTaskSummary, filter: Filter): boolean => filter === "all" || (filter === "finished" ? Boolean(task.cancelledAt || !task.nextRunAt) : filter === "paused" ? !task.cancelledAt && !task.enabled && Boolean(task.nextRunAt) : !task.cancelledAt && task.enabled && Boolean(task.nextRunAt)) as boolean;
const emptyDraft = (): ScheduledTaskInput => ({ requestId: crypto.randomUUID(), title: "", employeeId: "", workspaceId: "", prompt: "", schedule: { kind: "daily", time: "09:00", timeZone: DISPLAY_ZONE } });

function TaskDetails({ task, active, focusRun, onEdit, onSession }: { task: ScheduledTaskSummary; active: boolean; focusRun?: ScheduledTaskRunView; onEdit(): void; onSession(run: ScheduledTaskRunView): void }): React.ReactElement {
  return <section className="task-details" aria-label={`${task.title}的详情`}>
    <div className="detail-prompt"><h2>{task.title}</h2><p>{focusRun?.prompt ?? task.prompt}</p><dl><dt>{focusRun ? "显示时区" : "计划时区"}</dt><dd>{focusRun ? DISPLAY_ZONE : task.schedule.kind === "once" ? "单次时间已保存为绝对时间" : task.schedule.timeZone}</dd><dt>执行目录</dt><dd><code>{focusRun ? focusRun.cwd || "未解析执行目录" : task.workspaceCwd || "目录不可用"}</code></dd></dl>
      {task.employeeUnavailableReason || task.workspaceUnavailableReason ? <Alert type="error" showIcon title={task.employeeUnavailableReason || task.workspaceUnavailableReason} action={<WandButton size="small" onClick={onEdit}>修改配置</WandButton>}/> : null}
      {!task.cancelledAt ? <WandButton size="small" kind="ghost" onClick={onEdit}><WandIcon name="edit"/>编辑任务</WandButton> : null}
    </div>
    <ExecutionHistory key={`${task.id}:${focusRun?.id ?? "latest"}`} task={task} records={histories[task.id] ?? []} active={active} focusRun={focusRun} onSession={onSession}/>
  </section>;
}

function Preview() {
  const reduced = useReducedMotion();
  const [layout, setLayout] = React.useState<Layout>(INITIAL_LAYOUT);
  const [listVisited, setListVisited] = React.useState(INITIAL_LAYOUT === "list");
  const [calendarVisited, setCalendarVisited] = React.useState(INITIAL_LAYOUT === "calendar");
  const [listHidden, setListHidden] = React.useState(INITIAL_LAYOUT !== "list");
  const [calendarHidden, setCalendarHidden] = React.useState(INITIAL_LAYOUT !== "calendar");
  React.useEffect(() => { if (reduced) { setListHidden(layout !== "list"); setCalendarHidden(layout !== "calendar"); } }, [layout, reduced]);
  const [tasks, setTasks] = React.useState(initialTasks);
  const [scene, setScene] = React.useState<Scene>("normal");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [visited, setVisited] = React.useState<string[]>([]);
  React.useEffect(() => { setVisited(previous => [...new Set([...previous, ...expanded])]); }, [expanded]);
  const [menuId, setMenuId] = React.useState("");
  const [cancelId, setCancelId] = React.useState("");
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const [editingId, setEditingId] = React.useState("");
  const [draft, setDraft] = React.useState<ScheduledTaskInput>(emptyDraft);
  const draftCache = React.useRef(new Map<string, ScheduledTaskInput>());
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [formError, setFormError] = React.useState("");
  const [session, setSession] = React.useState<ScheduledTaskRunView | null>(null);
  const theme = React.useSyncExternalStore(wandThemeStore.subscribe, wandThemeStore.getSnapshot);
  const editorTrigger = React.useRef<HTMLButtonElement>(null);
  const nameInput = React.useRef<HTMLInputElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = React.useRef(0);
  const [dateOpen, setDateOpen] = React.useState(false);
  const [timeOpen, setTimeOpen] = React.useState(false);
  const dateRef = React.useRef<React.ComponentRef<typeof DatePicker>>(null);
  const timeRef = React.useRef<React.ComponentRef<typeof TimePicker>>(null);
  usePopupDismiss(dateOpen, () => { setDateOpen(false); dateRef.current?.focus(); });
  usePopupDismiss(timeOpen, () => { setTimeOpen(false); timeRef.current?.focus(); });
  const hideEditor = React.useCallback(() => { ++generation.current; if (timer.current) clearTimeout(timer.current); setDateOpen(false); setTimeOpen(false); setEditorOpen(false); setPhase("idle"); }, []);
  const closeEditor = React.useCallback(() => { hideEditor(); editorTrigger.current?.focus({ preventScroll: true }); }, [hideEditor]);
  React.useEffect(() => () => { ++generation.current; if (timer.current) clearTimeout(timer.current); }, []);
  React.useLayoutEffect(() => {
    if (!editorOpen) return;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    const focus = () => { if (!cancelled && nameInput.current && getComputedStyle(nameInput.current).visibility === "visible") nameInput.current.focus({ preventScroll: true }); };
    const frame = requestAnimationFrame(() => {
      const shell = document.querySelector<HTMLElement>(".editor-shell");
      shell?.scrollIntoView({ block: "start", behavior: "instant" });
      if (nameInput.current && getComputedStyle(nameInput.current).visibility === "visible") focus();
      else void Promise.allSettled(shell?.getAnimations().map(animation => animation.finished) ?? []).then(focus);
    });
    document.addEventListener("pointerdown", cancel, true); document.addEventListener("keydown", cancel, true);
    return () => { cancelled = true; cancelAnimationFrame(frame); document.removeEventListener("pointerdown", cancel, true); document.removeEventListener("keydown", cancel, true); };
  }, [editorOpen, focusRequest]);
  React.useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || hasOpenPopupSurface()) return;
      if (session) { event.preventDefault(); setSession(null); }
      else if (cancelId) { event.preventDefault(); setCancelId(""); }
      else if (editorOpen) { event.preventDefault(); closeEditor(); }
      else if (expanded.length && layout === "list") { event.preventDefault(); document.querySelector<HTMLButtonElement>(`[data-task-id="${expanded[0]}"] .task-title-button`)?.focus({ preventScroll: true }); setExpanded([]); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [session, cancelId, editorOpen, expanded, closeEditor, layout]);
  const dataKnown = scene !== "loading" && scene !== "error";
  const data = scene === "empty" || !dataKnown ? [] : tasks;
  const shown = React.useMemo(() => data.filter(task => matchesFilter(task, filter) && `${task.title} ${task.prompt} ${task.employeeName} ${task.workspaceName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [data, filter, query]);
  const next = nextTask(data);
  const problems = data.filter(task => !task.cancelledAt && task.nextRunAt && task.enabled && (task.employeeUnavailableReason || task.workspaceUnavailableReason));
  const counts = (value: Filter) => data.filter(task => matchesFilter(task, value)).length;
  const changeFilter = (value: string) => { setFilter(value as Filter); setExpanded([]); setMenuId(""); setCancelId(""); setSession(null); };
  const toggle = (id: string) => { setExpanded(previous => previous.includes(id) ? [] : [id]); setSession(null); };
  const selectCalendarTask = React.useCallback((id: string | null) => { setExpanded(id ? [id] : []); setSession(null); setCancelId(""); }, []);
  const changeLayout = (value: string) => { if (value !== "list" && value !== "calendar") return; hideEditor(); setExpanded([]); setMenuId(""); setCancelId(""); setSession(null); setLayout(value); if (value === "list") { setListHidden(false); setListVisited(true); } else { setCalendarHidden(false); setCalendarVisited(true); } };
  const openEditor = (task?: ScheduledTaskSummary) => {
    if (layout === "calendar") setExpanded([]);
    draftCache.current.set(editingId || "new", clone(draft));
    if (task) { setEditingId(task.id); setDraft(clone(draftCache.current.get(task.id) ?? { requestId: crypto.randomUUID(), title: task.title, employeeId: task.employeeId, workspaceId: task.workspaceId, prompt: task.prompt, schedule: clone(task.schedule) })); }
    else { setEditingId(""); setDraft(clone(draftCache.current.get("new") ?? emptyDraft())); }
    setPhase("idle"); setFormError(""); setMenuId(""); setDateOpen(false); setTimeOpen(false); setEditorOpen(true); setFocusRequest(value => value + 1);
  };
  const patchDraft = (patch: Partial<ScheduledTaskInput>) => { ++generation.current; if (timer.current) clearTimeout(timer.current); setDraft(old => ({ ...old, ...patch })); setPhase("idle"); setFormError(""); };
  const chooseKind = (kind: string) => {
    const base = draft.schedule.kind === "once" ? { time: "09:00", timeZone: DISPLAY_ZONE } : draft.schedule;
    patchDraft({ schedule: kind === "once" ? { kind: "once", runAt: "2026-10-15T09:00:00+08:00" } : kind === "weekly" ? { kind: "weekly", time: base.time, timeZone: base.timeZone, weekday: draft.schedule.kind === "weekly" ? draft.schedule.weekday : 1 } : { kind: "daily", time: base.time, timeZone: base.timeZone } });
  };
  const save = async () => {
    if (phase !== "idle") return;
    const error = scheduleInputError(draft, PREVIEW_NOW.getTime());
    if (error) { setFormError(error); return; }
    const employee = employees.find(item => item.value === draft.employeeId);
    const workspace = workspaces.find(item => item.value === draft.workspaceId);
    if (!employee || !workspace) { setFormError("请选择当前可用的员工与工作区。"); return; }
    const epoch = ++generation.current;
    setPhase("saving");
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (generation.current !== epoch) return;
    const original = tasks.find(task => task.id === editingId);
    const id = editingId || `preview-${crypto.randomUUID()}`;
    const task: ScheduledTaskSummary = { ...original, id, creationFingerprint: "preview-only", title: draft.title?.trim() || draft.prompt.trim().split("\n")[0].slice(0, 80),
      employeeId: draft.employeeId, employeeName: employee.label, workspaceId: workspace.value, workspaceName: workspace.label, workspaceCwd: workspace.cwd, prompt: draft.prompt,
      employeeUnavailableReason: null, workspaceUnavailableReason: null, schedule: clone(draft.schedule), enabled: original?.schedule.kind === "once" && !original.nextRunAt ? true : original?.enabled ?? true,
      nextRunAt: nextScheduledTime(draft.schedule, PREVIEW_NOW), revision: (original?.revision ?? 0) + 1, createdAt: original?.createdAt ?? PREVIEW_NOW.toISOString(), updatedAt: PREVIEW_NOW.toISOString(), cancelledAt: null, lastRun: original?.lastRun ?? null };
    draftCache.current.delete(editingId || "new");
    setTasks(previous => original ? previous.map(item => item.id === id ? task : item) : [task, ...previous]); setEditingId(id); setScene("normal"); setPhase("sent");
    timer.current = setTimeout(() => { if (generation.current === epoch) setPhase("result"); }, MOTION_DWELL_SENT_MS);
  };
  let previewAt: string | null = null;
  try { previewAt = nextScheduledTime(draft.schedule, PREVIEW_NOW); } catch { /* Inline validation owns invalid dates/zones. */ }
  const switchEnabled = (task: ScheduledTaskSummary) => setTasks(previous => previous.map(item => item.id === task.id ? { ...item, enabled: !item.enabled, revision: item.revision + 1 } : item));
  const renderActions = (task: ScheduledTaskSummary) => <div className="task-actions">
      {task.nextRunAt && !task.cancelledAt ? <Tooltip title={task.enabled ? "暂停后续计划" : "恢复后续计划"}><span className="switch-hitbox" onClick={event => { if (event.target === event.currentTarget && (task.enabled || !task.employeeUnavailableReason && !task.workspaceUnavailableReason)) switchEnabled(task); }}><Switch size="small" checked={task.enabled} aria-label={`${task.title}的计划开关`} disabled={!task.enabled && Boolean(task.employeeUnavailableReason || task.workspaceUnavailableReason)} onChange={() => switchEnabled(task)}/></span></Tooltip> : <span className="switch-placeholder"/>}
      <WandDropdownMenu open={menuId === task.id} onOpenChange={open => setMenuId(open ? task.id : "")}><WandDropdownMenuTrigger render={<WandIconButton aria-label={`${task.title}的更多操作`}><WandIcon name="more" size={17}/></WandIconButton>}/><WandDropdownMenuContent align="end" popupOwner={`preview-task-${task.id}`}>
        {!task.cancelledAt && <WandDropdownMenuItem icon="edit" onSelect={() => openEditor(task)}>编辑任务</WandDropdownMenuItem>}
        {task.nextRunAt && !task.cancelledAt && <WandDropdownMenuItem icon={task.enabled ? "stop" : "resume"} disabled={!task.enabled && Boolean(task.employeeUnavailableReason || task.workspaceUnavailableReason)} onSelect={() => switchEnabled(task)}>{task.enabled ? "暂停计划" : "恢复计划"}</WandDropdownMenuItem>}
        <WandDropdownMenuItem icon="history" onSelect={() => setExpanded([task.id])}>执行记录</WandDropdownMenuItem>
        {task.lastRun?.sessionId && <WandDropdownMenuItem icon="chat" onSelect={() => { setExpanded([task.id]); setSession(task.lastRun); }}>查看会话</WandDropdownMenuItem>}
        {!task.cancelledAt && <WandDropdownMenuItem icon="stop" tone="danger" onSelect={() => { setExpanded([task.id]); setCancelId(task.id); }}>取消计划</WandDropdownMenuItem>}
      </WandDropdownMenuContent></WandDropdownMenu>
    </div>;
  const renderDetails = (task: ScheduledTaskSummary, paneActive = layout === "list", focusRun?: ScheduledTaskRunView) => <><TaskDetails task={task} active={paneActive && expanded.includes(task.id) && !editorOpen && cancelId !== task.id} focusRun={focusRun} onEdit={() => openEditor(task)} onSession={run => setSession(run)}/>{cancelId === task.id && <div className="cancel-confirm" role="alert"><div><strong>取消后续计划？</strong><p>保留历史，不停止已开始的执行。此操作只影响预览。</p></div><WandButton kind="danger" size="small" onClick={() => { setTasks(previous => previous.map(item => item.id === task.id ? { ...item, enabled: false, nextRunAt: null, cancelledAt: PREVIEW_NOW.toISOString() } : item)); setCancelId(""); }}>确认取消</WandButton><WandButton size="small" onClick={() => setCancelId("")}>保留计划</WandButton></div>}{session?.taskId === task.id && <div className="session-preview" role="status"><WandIcon name="chat" size={17}/><div><strong>关联会话入口</strong><p>正式页面会打开这一次执行的独立会话。设计稿不连接服务、不虚构执行回复。</p><code>{session.cwd}</code></div><WandIconButton aria-label="关闭会话入口说明" onClick={() => setSession(null)}><WandIcon name="close"/></WandIconButton></div>}</>;
  const locateTask = (task: ScheduledTaskSummary) => { if (layout !== "list") changeLayout("list"); setFilter("all"); setQuery(""); setExpanded([task.id]); requestAnimationFrame(() => { const row = document.querySelector(`[data-task-id="${task.id}"]`); row?.scrollIntoView({ block: "nearest", behavior: "instant" }); row?.querySelector<HTMLButtonElement>(".task-title-button")?.focus({ preventScroll: true }); }); };
  const nav: { label: string; icon: WandIconName }[] = [{ label: "对话", icon: "chat" }, { label: "工作区", icon: "explorer" }, { label: "任务", icon: "board" }, { label: "团队", icon: "users" }, { label: "定时", icon: "history" }];
  return <WandUiProvider>
    <a href="#scheduled-main" className="skip-link">跳到定时任务内容</a>
    <div className="preview-toolbar"><span><strong>设计预览</strong><span>示例数据 · 10 月 14 日 10:30</span></span><div><WandSelect ariaLabel="预览状态" value={scene} options={[{ value: "normal", label: "正常列表" }, { value: "empty", label: "空列表" }, { value: "loading", label: "首次加载" }, { value: "error", label: "首次失败" }, { value: "refresh-error", label: "刷新失败" }]} onValueChange={value => { closeEditor(); setScene(value as Scene); setExpanded([]); setSession(null); }}/><WandSelect ariaLabel="预览主题" value={theme} options={[{ value: "warm", label: "暖白铜色" }, { value: "blue", label: "石墨蓝" }, { value: "forest", label: "森林绿" }, { value: "mauve", label: "雾紫" }, { value: "graphite", label: "深色石墨" }]} onValueChange={value => setWandTheme(value as WandThemeId)}/></div></div>
    <div className="preview-workspace"><nav className="preview-rail" aria-label="工作台导航示意"><span className="brand-mark" aria-label="Wand"><WandBrandMark/></span>{nav.map(item => <WandButton key={item.label} className="rail-item" kind="ghost" aria-current={item.label === "定时" ? "page" : undefined} aria-label={item.label === "定时" ? "定时任务" : `${item.label}（此预览不含该页）`} disabled={item.label !== "定时"} onClick={() => { closeEditor(); setExpanded([]); setSession(null); }}><WandIcon name={item.icon} size={18}/><span>{item.label}</span></WandButton>)}<div className="rail-bottom"><WandIconButton disabled aria-label="设置（此预览不含该页）"><WandIcon name="gear" size={18}/></WandIconButton><span>设置</span></div></nav>
      <main id="scheduled-main" className="scheduled-main"><header className="page-header"><div><h1>定时任务</h1></div><div className="page-header-actions"><WandStretchTabs ariaLabel="定时任务视图" value={layout} onValueChange={changeLayout} tabs={[{ value: "list", label: "列表" }, { value: "calendar", label: "日历" }]}/><WandButton ref={editorTrigger} className="create-trigger" kind="primary" aria-label={editorOpen ? "收起编辑" : "新建任务"} aria-expanded={editorOpen} onClick={() => editorOpen ? closeEditor() : openEditor()}><ConversationMorphIcon active={editorOpen} from="plus" to="close" size={16}/><span className="create-label">{editorOpen ? "收起编辑" : "新建任务"}</span></WandButton></div></header>
        <div className="page-scroll"><div className="page-content" data-layout={layout}>
          <NextTaskPanel task={next} scene={scene} hasTasks={data.length > 0} reduced={reduced} onEdit={openEditor} onLocate={locateTask}/>
          <div className="editor-shell" data-open={editorOpen} inert={!editorOpen} aria-hidden={!editorOpen}><div><section className="editor" aria-label={editingId ? "编辑定时任务" : "新建定时任务"}>
            <header><h2>{editingId ? "编辑任务" : "安排一项新工作"}</h2><p>选择谁来做、在哪里做，再设定执行时间。保存不会立即执行。</p></header>
            <Form layout="vertical" onFinish={() => void save()}><div className="form-grid"><Form.Item label="任务名称（选填）" className="form-full" htmlFor="task-name"><WandInput ref={nameInput} id="task-name" maxLength={200} value={draft.title || ""} placeholder="留空则使用提示词的第一行" onChange={event => patchDraft({ title: event.target.value })}/></Form.Item>
              <Form.Item label="执行员工" required><WandSelect ariaLabel="执行员工" value={draft.employeeId || undefined} placeholder="选择一位员工" searchable searchPlaceholder="搜索员工" options={employees} popupOwner="preview-schedule-form" onValueChange={employeeId => patchDraft({ employeeId })}/></Form.Item>
              <Form.Item label="执行工作区" required><WandSelect ariaLabel="执行工作区" value={draft.workspaceId || undefined} placeholder="选择一个已有工作区" searchable searchPlaceholder="搜索工作区" options={workspaces} popupOwner="preview-schedule-form" onValueChange={workspaceId => patchDraft({ workspaceId })}/></Form.Item>
              <div className="form-summary form-full">使用员工当前的工具、模型与权限配置。{draft.workspaceId && <code>{workspaces.find(workspace => workspace.value === draft.workspaceId)?.cwd || "原工作区不可用，请重新选择"}</code>}</div>
              <Form.Item label="执行提示词" required htmlFor="task-prompt" className="form-full"><Input.TextArea id="task-prompt" value={draft.prompt} rows={4} placeholder="写清要完成的工作、约束和期望交付，也可以直接粘贴完整要求。" onChange={event => patchDraft({ prompt: event.target.value })}/></Form.Item>
              <Form.Item label="执行频率" className="form-full"><WandStretchTabs ariaLabel="执行频率" value={draft.schedule.kind} tabs={[{ value: "once", label: "仅一次" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }]} onValueChange={chooseKind}/></Form.Item>
              {draft.schedule.kind === "once" ? <Form.Item label="执行日期与时间" required className="form-full"><DatePicker ref={dateRef} aria-label="执行日期与时间" showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" open={dateOpen} onOpenChange={setDateOpen} value={draft.schedule.runAt ? dayjs(draft.schedule.runAt) : null} panelRender={panel => <div data-wand-popup-owner="preview-schedule-form">{panel}</div>} classNames={{ popup: { root: "preview-date-popup" } }} onChange={value => patchDraft({ schedule: { kind: "once", runAt: value?.toISOString() || "" } })}/></Form.Item> : <>
                <Form.Item label="执行时间" required><TimePicker ref={timeRef} aria-label="执行时间" value={dayjs(`2000-01-01T${draft.schedule.time}`)} format="HH:mm" needConfirm={false} open={timeOpen} onOpenChange={setTimeOpen} panelRender={panel => <div data-wand-popup-owner="preview-schedule-form">{panel}</div>} onChange={value => { if (draft.schedule.kind !== "once") patchDraft({ schedule: { ...draft.schedule, time: value?.format("HH:mm") || "" } }); }}/></Form.Item>
                {draft.schedule.kind === "weekly" && <Form.Item label="星期" required><WandSelect ariaLabel="执行星期" value={String(draft.schedule.weekday)} options={[1, 2, 3, 4, 5, 6, 0].map(value => ({ value: String(value), label: WEEKDAYS[value] }))} popupOwner="preview-schedule-form" onValueChange={weekday => { if (draft.schedule.kind === "weekly") patchDraft({ schedule: { ...draft.schedule, weekday: Number(weekday) } }); }}/></Form.Item>}
                <Form.Item label="计划时区" required><WandSelect ariaLabel="计划时区" value={draft.schedule.timeZone} options={scheduleTimeZones()} searchable searchPlaceholder="搜索时区" popupOwner="preview-schedule-form" onValueChange={timeZone => { if (draft.schedule.kind !== "once") patchDraft({ schedule: { ...draft.schedule, timeZone } }); }}/></Form.Item>
              </>}
            </div><div className="schedule-summary"><WandIcon name="history" size={16}/><span>{previewAt ? `首次预计：${formatDate(previewAt)} · ${DISPLAY_ZONE}` : "核对执行时间后显示下次计划"}<small>{draft.schedule.kind === "once" ? `日期选择器按浏览器时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 显示` : scheduleLabel(draft.schedule)} · 以示例时钟计算</small></span></div>
            {formError && <Alert type="error" showIcon title={formError} role="alert"/>}
            <div className="form-footer"><WandButton className="save-button" kind="primary" type="submit" loading={phase === "saving"} disabled={phase !== "idle"} aria-live="polite">{phase === "saving" ? "保存中" : phase === "sent" ? "已保存" : phase === "result" ? "已保存到预览" : editingId ? "保存修改" : "创建任务"}</WandButton><WandButton kind="ghost" onClick={closeEditor}>返回列表</WandButton><span>仅保存到本页内存，不创建真实计划。</span></div></Form>
          </section></div></div>
          <div className="list-toolbar"><WandStretchTabs ariaLabel="定时任务筛选" value={filter} onValueChange={changeFilter} tabs={([['all', '全部'], ['active', '待执行'], ['paused', '已暂停'], ['finished', '已结束']] as const).map(([value, label]) => ({ value, label: <span>{label}<span className="filter-count">{dataKnown ? counts(value) : "—"}</span></span> }))}/><div className="search-tools">{problems.length ? <Tooltip title={`${problems.length} 项配置需要处理`}><WandIconButton className="problem-link" aria-label={`${problems.length} 项配置需要处理`} onClick={() => locateTask(problems[0])}><WandIcon name="warning" size={16}/></WandIconButton></Tooltip> : null}<WandSearchField value={query} onValueChange={value => { setQuery(value); setExpanded([]); setMenuId(""); setCancelId(""); }} label="搜索定时任务" placeholder="搜索任务、员工或工作区"/><Tooltip title="重置示例数据与预览草稿"><WandIconButton aria-label="重置预览" onClick={() => { closeEditor(); draftCache.current.clear(); setEditingId(""); setDraft(emptyDraft()); setTasks(initialTasks()); setScene("normal"); setExpanded([]); setVisited([]); setSession(null); setFilter("all"); setQuery(""); setCancelId(""); }}><WandIcon name="refresh" size={16}/></WandIconButton></Tooltip></div></div>
          {(!dataKnown || query) && <div className="list-context">{!dataKnown ? scene === "loading" ? "正在读取计划…" : "计划数量暂不可用" : `找到 ${shown.length} 项匹配`}</div>}
          {scene === "error" || scene === "refresh-error" ? <Alert className="read-error" type="error" showIcon title={scene === "error" ? "未能读取定时任务" : "刷新失败，保留上次读取的计划"} description="示例连接失败。不会修改计划或重新发送工作。" action={<WandButton size="small" onClick={() => setScene("normal")}>重新读取</WandButton>}/> : null}
          <div className="schedule-view-host"><div className="schedule-view-pane" hidden={listHidden} data-active={layout === "list"} inert={layout !== "list"} aria-hidden={layout !== "list"} onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && layout !== "list") setListHidden(true); }}>{listVisited && (scene === "loading" ? <section className="loading-list" aria-label="正在读取定时任务" role="status">{[0, 1, 2].map(item => <Skeleton key={item} title={{ width: "32%" }} paragraph={{ rows: 1, width: "65%" }} active={!reduced}/>)}</section> : shown.length ? <TaskAgenda tasks={shown} expanded={expanded} visited={visited} onToggle={toggle} renderActions={renderActions} renderDetails={renderDetails}/> : <div className="agenda-empty">{scene === "error" ? <p className="secondary">恢复连接后再显示计划。</p> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><strong>{data.length ? "没有匹配的任务" : "还没有定时任务"}</strong><p>{data.length ? "试试其他关键词，或切换计划状态。" : "选择一位员工，把要重复完成的工作安排好。"}</p></>}>{data.length ? <WandButton kind="ghost" onClick={() => { setQuery(""); changeFilter("all"); }}>清空筛选</WandButton> : <WandButton onClick={() => openEditor()}>新建任务</WandButton>}</Empty>}</div>)}</div><div className="schedule-view-pane" hidden={calendarHidden} data-active={layout === "calendar"} inert={layout !== "calendar"} aria-hidden={layout !== "calendar"} onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && layout !== "calendar") setCalendarHidden(true); }}>{calendarVisited && <ScheduleCalendar tasks={shown} allTasks={data} records={histories} active={layout === "calendar" && !editorOpen} selectedTaskId={expanded[0] ?? null} onSelectTask={selectCalendarTask} renderDetails={(task, run) => renderDetails(task, layout === "calendar", run)}/>}</div></div>
          <footer className="page-foot"><Tooltip title={`时间按 ${DISPLAY_ZONE} 显示。每次执行创建独立会话；暂停不停止当前执行。服务恢复后合并错过的重复周期，不批量补跑。`}><span className="rule-note" tabIndex={0}><WandIcon name="info" size={13}/>主机与 Wand 服务需保持运行</span></Tooltip></footer>
        </div></div>
      </main>
    </div>
  </WandUiProvider>;
}

createRoot(document.getElementById("root")!).render(<Preview/>);
