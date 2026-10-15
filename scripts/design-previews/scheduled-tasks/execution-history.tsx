import * as React from "react";
import { Tooltip } from "antd";
import type { ScheduledTaskRunView, ScheduledTaskSummary } from "../../../src/scheduled-task-types.js";
import { WandButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import { scheduledRunState } from "../../../src/web-ui/react/scheduled-tasks/model.js";
import { RunState } from "./agenda-view";
import { dateKey, executionDays, latestExecution, type ExecutionDay } from "./execution-model";
import { DISPLAY_ZONE, PREVIEW_NOW } from "./fixtures";
import "./history.css";

const labels = { completed: "完成", failed: "失败", running: "执行中", pending: "等待执行", unknown: "待确认", skipped: "已跳过", mixed: "混合状态", empty: "未提供记录" };
const executionTime = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: DISPLAY_ZONE, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
function dayDescription(day: ExecutionDay): string {
  return `${day.key} · ${!day.available ? "未到时间或计划尚未创建" : !day.records.length ? "未提供记录" : Object.entries(day.counts).map(([state, count]) => `${labels[state as ScheduledTaskRunView["executionStatus"]]} ${count} 次`).join("，")}`;
}

export function ExecutionRecord({ run, onSession }: { run: ScheduledTaskRunView; onSession(run: ScheduledTaskRunView): void }) {
  return <li className="execution-record" data-run-id={run.id}><div className="run-top"><time dateTime={run.claimedAt} title={`实际触发：${run.claimedAt} · 计划：${run.scheduledAt}`}>{executionTime(run.claimedAt)}</time><RunState run={run}/>{run.sessionId && <WandButton size="small" kind="ghost" onClick={() => onSession(run)}>查看会话<WandIcon name="chevron" size={12}/></WandButton>}</div>
    <code title="本次执行时保存的目录">{run.cwd || "未解析执行目录"}</code>{run.error && <p className="run-error" data-tone={run.executionStatus}>{run.error}</p>}
  </li>;
}

export function ExecutionHistory({ task, records, active, focusRun, onSession }: {
  task: ScheduledTaskSummary; records: readonly ScheduledTaskRunView[]; active: boolean; focusRun?: ScheduledTaskRunView; onSession(run: ScheduledTaskRunView): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [visited, setVisited] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const latest = latestExecution(records);
  const shownRun = focusRun ?? latest;
  const days = React.useMemo(() => executionDays(records, PREVIEW_NOW, task.createdAt, DISPLAY_ZONE), [records, task.createdAt]);
  const [focusKey, setFocusKey] = React.useState(() => shownRun ? dateKey(shownRun.claimedAt, DISPLAY_ZONE) : dateKey(PREVIEW_NOW, DISPLAY_ZONE));
  const trigger = React.useRef<HTMLButtonElement>(null);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const id = React.useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const openSession = (run: ScheduledTaskRunView) => { setOpen(false); onSession(run); };
  usePopupDismiss(open && active, close);
  React.useEffect(() => { if (!active) setOpen(false); }, [active]);
  const selectedDay = days.find(day => day.key === selected);
  const moveFocus = (event: React.KeyboardEvent, index: number) => {
    const directions: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1, Home: -index, End: days.length - 1 - index };
    const delta = directions[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    let next = Math.max(0, Math.min(days.length - 1, index + delta));
    while (next >= 0 && next < days.length && !days[next].available) next += delta < 0 ? -1 : 1;
    const day = days[next]; if (!day?.available) return;
    setFocusKey(day.key); buttons.current.get(day.key)?.focus({ preventScroll: true });
    buttons.current.get(day.key)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  };
  return <section className="detail-history" aria-label={`${task.title}的执行记录`}>
    <header><h2>{focusRun ? "本次执行" : "最近执行"}</h2><WandButton ref={trigger} size="small" kind="ghost" className="history-toggle" aria-expanded={open && active} aria-controls={id} onClick={() => { if (open) close(); else { setVisited(true); setSelected(null); setOpen(true); } }}>执行情况<span className="task-chevron" data-expanded={open && active}><WandIcon name="chevronDown" size={13}/></span></WandButton></header>
    {shownRun ? <ol className="latest-record" aria-label={focusRun ? "选中的一次执行" : "最近一次执行"}><ExecutionRecord run={shownRun} onSession={openSession}/></ol> : <p className="secondary">尚未执行；到达计划时间后会保留记录。</p>}
    <div id={id} className="history-expansion" data-open={open && active} inert={!open || !active} aria-hidden={!open || !active}><div>{visited && <div className="execution-heatmap" aria-label="近12周执行热力图">
      <div className="heat-summary"><span>近 12 周</span><span>已提供 {records.length} 条记录</span></div>
      <div className="heat-scroll"><div className="heat-months" aria-hidden="true"><span/>{days.filter((_, index) => index % 7 === 0).map((day, week) => <span key={day.key}>{week === 0 || day.key.slice(0, 7) !== days[(week - 1) * 7].key.slice(0, 7) ? `${Number(day.key.slice(5, 7))}月` : ""}</span>)}</div>
        <div className="heat-layout"><div className="heat-weekdays" aria-hidden="true">{["一", "", "三", "", "五", "", "日"].map((day, index) => <span key={index}>{day}</span>)}</div>
          <div className="heat-board" role="group" aria-label="日期方格，左右换周，上下换日">{days.map((day, index) => <Tooltip key={day.key} title={dayDescription(day)}><WandButton className="heat-cell" kind="ghost" ref={node => { if (node) buttons.current.set(day.key, node); else buttons.current.delete(day.key); }} style={{ gridColumn: Math.floor(index / 7) + 1, gridRow: index % 7 + 1 }} data-date={day.key} data-outcome={day.outcome} data-level={day.level} aria-label={dayDescription(day)} aria-pressed={selected === day.key} disabled={!day.available} tabIndex={focusKey === day.key ? 0 : -1} onFocus={() => setFocusKey(day.key)} onKeyDown={event => moveFocus(event, index)} onClick={() => setSelected(day.key)}>{day.outcome === "mixed" ? "±" : day.outcome === "unknown" ? "?" : day.outcome === "skipped" ? "−" : null}</WandButton></Tooltip>)}</div>
        </div>
      </div>
      <div className="heat-legend" aria-label="热力图图例">{(["completed", "failed", "running", "unknown", "mixed", "skipped", "empty"] as const).map(state => <span key={state}><i data-outcome={state}/>{state === "running" ? "运行/等待" : labels[state]}</span>)}</div>
      <p className="heat-help">按实际触发日归类；空白仅表示未提供记录。点日期查看，方向键可移动。</p>
      {selectedDay && <section className="heat-day-detail" aria-label={`${selectedDay.key}执行记录`}><header><h3>{selectedDay.key}</h3><span>{selectedDay.records.length ? `${selectedDay.records.length} 次` : "未提供记录"}</span></header>{selectedDay.records.length ? <ol>{selectedDay.records.map(run => <ExecutionRecord key={run.id} run={run} onSession={openSession}/>)}</ol> : <p className="secondary">已提供的记录中没有这一天，不能据此判定成功或失败。</p>}</section>}
    </div>}</div></div>
  </section>;
}
