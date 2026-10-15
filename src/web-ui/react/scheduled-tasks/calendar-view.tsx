import * as React from "react";
import { Alert, Avatar, Calendar } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import type { ScheduledTaskRunFactView, ScheduledTaskSummary, ScheduledTaskCalendarResponse } from "../../../scheduled-task-types.js";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { WandStretchTabs } from "../ui/stretch-tabs";
import { WandPopover } from "../ui/popover";
import { useReducedMotion } from "../ui/motion-tokens";
import { appointment } from "../../../scheduled-task-agenda.js";
import { PlushAvatar } from "../avatars/plush-avatar";
import { resolveEmployeeAvatar } from "../../../plush-avatar.js";
import { avatarFaceParts } from "../ai-teams/avatar";
import { weekPositions, type CalendarEntry as SharedCalendarEntry } from "../../../scheduled-task-calendar.js";
import { calendarProjection } from "./calendar-adapter";
import { addDateDays, dateKey } from "../../../scheduled-task-activity.js";
import { useScheduledPresentation } from "./presentation-context";
type CalendarEntry = SharedCalendarEntry<ScheduledTaskRunFactView>;

const outcomeLabels = { completed: "完成", failed: "失败", running: "执行中", pending: "等待", unknown: "待确认", skipped: "跳过" };
function entryState(entry: CalendarEntry): string {
  return entry.kind === "execution" ? entry.run.executionStatus : entry.task.employeeUnavailableReason || entry.task.workspaceUnavailableReason ? "blocked" : entry.waiting ? "waiting" : "planned";
}
function entryLabel(entry: CalendarEntry): string {
  return entry.kind === "execution" ? outcomeLabels[entry.run.executionStatus] : entryState(entry) === "blocked" ? "待修复" : entry.waiting ? "待触发" : "预计";
}
function entryEmployee(entry: CalendarEntry, employees: ReturnType<typeof useScheduledPresentation>["employees"]) {
  const id = entry.kind === "execution" ? entry.run.employeeId : entry.task.employeeId;
  return employees.find(employee => employee.id === id) ?? { id, name: entry.kind === "execution" ? "原执行员工" : entry.task.employeeName };
}
function CalendarFace({ entry }: { entry: CalendarEntry }) {
  const { employees } = useScheduledPresentation();
  const employee = entryEmployee(entry, employees), plush = resolveEmployeeAvatar(employee);
  const face = plush ? null : avatarFaceParts(employee, 22);
  return <span className="scheduled-calendar-face" role="img" aria-label={`${employee.name}的头像`} data-employee-id={employee.id}>{plush ? <PlushAvatar config={plush} size={22}/> : <Avatar size={22} shape="square" src={face?.src} icon={face?.icon} style={face?.style}/>}</span>;
}

function CalendarBar({ entry, selected, onSelect, onClose, content, style, position }: {
  entry: CalendarEntry; selected: boolean; onSelect(): void; onClose(): void; content: React.ReactNode; style?: React.CSSProperties; position?: { day: number; minute: number; lane: number; lanes: number };
}) {
  const { now, timeZone } = useScheduledPresentation();
  const time = appointment(entry.at, now, timeZone);
  return <WandPopover className="scheduled-calendar-detail-popover" sideOffset={0} ariaLabel={`${entry.task.title}的日历详情`} popupOwner={`calendar-entry-${entry.key}`} align="start" open={selected} onOpenChange={next => { if (!next) onClose(); }} trigger={<WandButton kind="ghost" className="scheduled-calendar-event" style={style} data-entry-key={entry.key} data-entry-kind={entry.kind} data-task={entry.task.id} data-date-key={entry.date} data-state={entryState(entry)} data-minute={position?.minute} data-day={position?.day} data-lane={position?.lane} data-lanes={position?.lanes} aria-pressed={selected}
    aria-label={`${entry.date} ${time.time} ${entry.task.title} · ${entry.kind === "execution" ? "实际执行" : "预计计划"} · ${entryLabel(entry)}`}
    title={`${time.exact} · ${timeZone}\n${entry.task.title}\n${entry.kind === "execution" ? "实际执行记录" : "按当前计划预计，不代表已执行"} · ${entryLabel(entry)}`}
    onClick={event => { event.stopPropagation(); onSelect(); }}>
    <CalendarFace entry={entry}/><span className="scheduled-calendar-event-copy"><span className="scheduled-calendar-event-meta"><time dateTime={entry.at}>{time.time}</time><span>{entryLabel(entry)}</span></span><span className="scheduled-calendar-event-title">{entry.task.title}</span></span>
  </WandButton>}>{content}</WandPopover>;
}

export function ScheduleCalendar({ tasks, allTasks, feed, loading, mode, onModeChange, onRangeChange, active, selectedTaskId, onSelectTask, renderDetails, renderActions }: {
  tasks: ScheduledTaskSummary[]; allTasks: ScheduledTaskSummary[]; feed: ScheduledTaskCalendarResponse | null; loading: boolean; mode: "month" | "week"; onModeChange(mode: "month" | "week"): void; onRangeChange(from: string, to: string): void; active: boolean;
  selectedTaskId: string | null; onSelectTask(id: string | null): void; renderDetails(task: ScheduledTaskSummary, focusRun?: ScheduledTaskRunFactView): React.ReactNode; renderActions(task: ScheduledTaskSummary): React.ReactNode;
}) {
  const { now, timeZone } = useScheduledPresentation();
  const today = dateKey(now, timeZone);
  const [value, setValue] = React.useState(() => dayjs(today));
  const reduced = useReducedMotion();
  const [monthHidden, setMonthHidden] = React.useState(mode !== "month");
  const [weekHidden, setWeekHidden] = React.useState(mode !== "week");
  const [selected, setSelected] = React.useState<CalendarEntry | null>(null);
  const [canvasScrollable, setCanvasScrollable] = React.useState(false);
  const monthScroll = React.useRef<HTMLDivElement>(null), weekScroll = React.useRef<HTMLDivElement>(null);
  const dateFocus = React.useRef(false);
  const navigated = React.useRef(false), initialFeed = React.useRef(false);
  const lastViewport = React.useRef("");
  const focusTarget = React.useRef<HTMLButtonElement | null>(null);
  const valueKey = value.format("YYYY-MM-DD");
  const monthStart = value.startOf("month").startOf("week").format("YYYY-MM-DD");
  const weekStart = value.startOf("week").format("YYYY-MM-DD");
  const start = mode === "month" ? monthStart : weekStart;
  const end = addDateDays(start, mode === "month" ? 41 : 6);
  const monthEnd = addDateDays(monthStart, 41);
  const projection = React.useMemo(() => calendarProjection(feed, tasks, monthStart, monthEnd, timeZone), [feed, tasks, monthStart, monthEnd, timeZone]);
  const rangeReady = feed?.range.from === monthStart && feed?.range.to === monthEnd && feed?.range.timeZone === timeZone;
  React.useEffect(() => { if (active) onRangeChange(monthStart, monthEnd); }, [active, monthStart, monthEnd, onRangeChange]);
  React.useEffect(() => { if (feed && !initialFeed.current) { initialFeed.current = true; if (!navigated.current) setValue(dayjs(dateKey(now, timeZone))); } }, [feed, now, timeZone]);
  React.useEffect(() => { onSelectTask(null); }, [mode, onSelectTask]);
  const byDate = React.useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const entry of projection.entries) { const entries = map.get(entry.date) ?? []; entries.push(entry); map.set(entry.date, entries); }
    return map;
  }, [projection]);
  const positions = React.useMemo(() => weekPositions(projection.entries, weekStart, timeZone), [projection, weekStart, timeZone]);
  const currentTask = selected ? allTasks.find(task => task.id === selected.task.id) ?? selected.task : null;
  const currentEntry = selected ? projection.entries.find(entry => entry.key === selected.key) : undefined;
  const selectedRun = currentEntry?.kind === "execution" ? currentEntry.run : selected?.kind === "execution" ? selected.run : undefined;
  const detailOpen = active && Boolean(selected && selectedTaskId === selected.task.id);
  const clearDetails = () => onSelectTask(null);
  const restoreFocus = () => {
    if (focusTarget.current?.isConnected) focusTarget.current.focus({ preventScroll: true });
    else (mode === "month" ? monthScroll.current?.querySelector<HTMLButtonElement>(`.scheduled-month-date-button[data-date-key="${valueKey}"]`) : weekScroll.current?.querySelector<HTMLButtonElement>('.scheduled-week-date[aria-pressed="true"]'))?.focus({ preventScroll: true });
  };
  const chooseDate = (date: Dayjs) => { navigated.current = true; setValue(date); clearDetails(); };
  const selectEntry = (entry: CalendarEntry, target: HTMLButtonElement | null) => { navigated.current = true; setSelected(entry); setValue(dayjs(entry.date)); focusTarget.current = target; onSelectTask(entry.task.id); };
  const chooseMode = (next: string) => { if (next === "month") setMonthHidden(false); else setWeekHidden(false); onModeChange(next as "month" | "week"); clearDetails(); };
  React.useLayoutEffect(() => {
    if (mode === "month") setMonthHidden(false); else setWeekHidden(false);
    if (reduced) { setMonthHidden(mode !== "month"); setWeekHidden(mode !== "week"); }
  }, [mode, reduced]);
  const navigate = (delta: number) => chooseDate(value.add(delta, mode === "month" ? "month" : "week"));
  const dateKeyDown = (event: React.KeyboardEvent, date: Dayjs) => {
    const movement: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = movement[event.key]; if (delta === undefined) return;
    event.preventDefault(); event.stopPropagation(); dateFocus.current = true;
    chooseDate(date.add(delta, "day"));
  };
  React.useLayoutEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (mode === "month") {
        const scroll = monthScroll.current, cell = scroll?.querySelector<HTMLElement>(`.scheduled-month-cell[data-date-key="${valueKey}"]`);
        if (scroll && cell && scroll.scrollWidth > scroll.clientWidth && (lastViewport.current !== `month:${start}` || dateFocus.current)) scroll.scrollLeft += cell.getBoundingClientRect().left - scroll.getBoundingClientRect().left - (scroll.clientWidth - cell.offsetWidth) / 2;
        lastViewport.current = `month:${start}`;
        if (dateFocus.current) { dateFocus.current = false; scroll?.querySelector<HTMLButtonElement>(`.scheduled-month-date-button[data-date-key="${valueKey}"]`)?.focus({ preventScroll: true }); }
      } else if (weekScroll.current) {
        const scroll = weekScroll.current;
        const index = Math.round((Date.parse(`${valueKey}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
        const dayWidth = (scroll.scrollWidth - 56) / 7;
        if (lastViewport.current !== `week:${start}`) {
          scroll.scrollLeft = Math.max(0, 56 + index * dayWidth - (scroll.clientWidth - dayWidth) / 2);
          scroll.scrollTop = 8 * 64;
        }
        lastViewport.current = `week:${start}`;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, mode, start, valueKey]);
  React.useEffect(() => {
    if (!active) return;
    const scroll = mode === "month" ? monthScroll.current : weekScroll.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() => {
      setCanvasScrollable(scroll.scrollWidth > scroll.clientWidth + 1);
      const node = mode === "month" ? scroll.querySelector<HTMLElement>(`.scheduled-month-cell[data-date-key="${valueKey}"]`) : scroll.querySelector<HTMLElement>(`.scheduled-week-date[data-date-key="${valueKey}"]`);
      if (!node) return;
      const box = node.getBoundingClientRect(), pane = scroll.getBoundingClientRect();
      if (box.left < pane.left || box.right > pane.right) scroll.scrollLeft += box.left - pane.left - (scroll.clientWidth - box.width) / 2;
    });
    observer.observe(scroll); return () => observer.disconnect();
  }, [active, mode, valueKey]);
  const popoverContent = selected && currentTask ? <div className="scheduled-calendar-selected-content" onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><header className="scheduled-calendar-selection-heading"><div><strong>{selected.kind === "execution" ? "本次执行记录" : currentTask.cancelledAt ? "计划已取消" : "预计计划"}</strong><span>{appointment(selected.at, now, timeZone).exact}</span></div>{renderActions(currentTask)}<WandIconButton aria-label="收起日历任务详情" onClick={() => { clearDetails(); restoreFocus(); }}><WandIcon name="close" size={16}/></WandIconButton></header>{renderDetails(currentTask, selectedRun)}</div> : null;
  const heading = mode === "month" ? value.format("YYYY年M月") : `${dayjs(start).format("M月D日")}—${dayjs(end).format("M月D日")}`;
  return <section className="scheduled-calendar-view" aria-label="全局日历，全部员工" data-scope="all-employees" data-calendar-mode={mode} data-selected-date={valueKey}>
    <header className="scheduled-calendar-toolbar"><div className="scheduled-calendar-navigation"><WandIconButton aria-label={mode === "month" ? "上个月" : "上一周"} onClick={() => navigate(-1)}><WandIcon name="chevronLeft" size={17}/></WandIconButton><h2>{heading}</h2><WandIconButton aria-label={mode === "month" ? "下个月" : "下一周"} onClick={() => navigate(1)}><WandIcon className="scheduled-calendar-forward" name="chevron" size={17}/></WandIconButton><WandButton size="small" kind="ghost" aria-label="回到今天" onClick={() => chooseDate(dayjs(today))}>今天</WandButton></div><WandStretchTabs className="scheduled-calendar-range" ariaLabel="日历范围" value={mode} onValueChange={chooseMode} tabs={[{ value: "month", label: "月" }, { value: "week", label: "周" }]}/></header>
    <div className="scheduled-calendar-explanation"><span><i data-kind="execution"/>实色：执行记录</span><span><i data-kind="planned"/>虚线：预计计划</span>{canvasScrollable && <span className="scheduled-calendar-scroll-hint">左右滑动</span>}<span>{timeZone}</span></div>
    {!rangeReady && <p className="scheduled-read-state" role="status">{loading ? "正在读取这个日期范围的日程…" : "该日期范围尚未读取，不代表没有安排。"}</p>}
    {projection.issues.length ? <Alert type="warning" showIcon title={projection.issues.join("；")}/> : null}
    {projection.truncated ? <Alert type="warning" showIcon title="当前范围达到读取上限，部分日程未显示。请打开单个任务的执行情况核对，空白不代表未执行。"/> : null}
    <div className="scheduled-calendar-canvases"><div className="scheduled-calendar-layer" hidden={monthHidden} data-active={mode === "month"} inert={mode !== "month"} aria-hidden={mode !== "month"} onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && mode !== "month") setMonthHidden(true); }}><div className="scheduled-calendar-month-scroll" ref={monthScroll}><Calendar className="scheduled-schedule-month-calendar" value={value} mode="month" fullscreen headerRender={() => null} onSelect={(date, info) => { if (info.source === "date") chooseDate(date); }} fullCellRender={(date, info) => {
      if (info.type !== "date") return info.originNode;
      const key = date.format("YYYY-MM-DD"), entries = byDate.get(key) ?? [];
      const visibleCount = entries.length > 3 ? 2 : 3;
      return <div className="scheduled-month-cell" data-date-key={key} data-today={key === today}><WandButton kind="ghost" className="scheduled-month-date-button" data-date-key={key} aria-label={date.format("YYYY年M月D日 dddd")} aria-current={key === today ? "date" : undefined} tabIndex={key === valueKey ? 0 : -1} onKeyDown={event => dateKeyDown(event, date)} onClick={event => { event.stopPropagation(); chooseDate(date); }}>{date.date()}</WandButton>
        <div className="scheduled-month-cell-events">{entries.slice(0, visibleCount).map(entry => <CalendarBar key={entry.key} entry={entry} selected={mode === "month" && selected?.key === entry.key && detailOpen} onClose={clearDetails} content={selected?.key === entry.key ? popoverContent : null} onSelect={() => selectEntry(entry, monthScroll.current?.querySelector<HTMLButtonElement>(`[data-entry-key="${CSS.escape(entry.key)}"]`) ?? null)}/>)}{entries.length > visibleCount && <WandButton className="scheduled-calendar-more" size="small" kind="ghost" onClick={event => { event.stopPropagation(); chooseDate(date); chooseMode("week"); }}>还有 {entries.length - visibleCount} 项</WandButton>}</div>
      </div>;
    }}/></div></div><div className="scheduled-calendar-layer" hidden={weekHidden} data-active={mode === "week"} inert={mode !== "week"} aria-hidden={mode !== "week"} onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === "opacity" && mode !== "week") setWeekHidden(true); }}><div className="scheduled-week-scroll" ref={weekScroll}><div className="scheduled-week-canvas"><div className="scheduled-week-days"><span className="scheduled-week-zone">时间</span>{Array.from({ length: 7 }, (_, day) => { const date = addDateDays(weekStart, day); return <WandButton key={date} kind="ghost" className="scheduled-week-date" data-date-key={date} aria-pressed={date === valueKey} onClick={() => chooseDate(dayjs(date))}><span>{dayjs(date).format("ddd")}</span><strong data-today={date === today}>{dayjs(date).date()}</strong></WandButton>; })}</div>
      <div className="scheduled-week-hours">{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="scheduled-week-hour-row" style={{ top: hour * 64 }}><span>{`${String(hour).padStart(2, "0")}:00`}</span></div>)}<div className="scheduled-week-day-lines">{Array.from({ length: 7 }, (_, index) => <div key={index}/>)}</div>
        {positions.map(position => <CalendarBar key={position.entry.key} entry={position.entry} selected={mode === "week" && selected?.key === position.entry.key && detailOpen} onClose={clearDetails} content={selected?.key === position.entry.key ? popoverContent : null} position={position} style={{ top: position.minute * 64 / 60, left: `calc(56px + (100% - 56px) * ${position.day + position.lane / position.lanes} / 7 + 3px)`, width: `calc((100% - 56px) / ${7 * position.lanes} - 6px)` }} onSelect={() => selectEntry(position.entry, weekScroll.current?.querySelector<HTMLButtonElement>(`[data-entry-key="${CSS.escape(position.entry.key)}"]`) ?? null)}/>)}
      </div></div></div></div></div>
    <p className="scheduled-calendar-footnote">{mode === "week" ? "横条按触发时刻定位，固定高度仅便于阅读，不表示执行时长。" : "任务直接显示在日期格中，点横条查看本次记录或计划详情。"} 未来安排按当前配置推算，不代表已执行。</p>
  </section>;
}
