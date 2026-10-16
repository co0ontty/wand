import * as React from "react";
import { Alert, Spin, Tooltip } from "antd";
import type { ScheduledTaskRunFactView, ScheduledTaskSummary, ScheduledTaskReadRange, ScheduledTaskActivityResponse } from "../../../scheduled-task-types.js";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { scheduledRunState } from "../scheduled-tasks/model.js";
import { RunState } from "./agenda-view";
import { dateKey, executionDays, latestExecution, type ExecutionDay as SharedExecutionDay } from "../../../scheduled-task-activity.js";
import { useScheduledPresentation } from "./presentation-context";
import { scheduledTasksRepository } from "./repository";
type ExecutionDay = SharedExecutionDay<ScheduledTaskRunFactView>;

const labels = { completed: "完成", failed: "失败", running: "执行中", pending: "等待执行", unknown: "待确认", skipped: "已跳过", mixed: "混合状态", empty: "未提供记录" };
const executionTime = (value: string, timeZone: string) => !Number.isFinite(Date.parse(value)) ? "时间待确认" : new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
function dayDescription(day: ExecutionDay): string {
  return `${day.key} · ${!day.available ? "未到时间或计划尚未创建" : !day.records.length ? "未提供记录" : Object.entries(day.counts).map(([state, count]) => `${labels[state as ScheduledTaskRunFactView["executionStatus"]]} ${count} 次`).join("，")}`;
}

export function ExecutionRecord({ run, onSession }: { run: ScheduledTaskRunFactView; onSession(run: ScheduledTaskRunFactView): void }) {
  const { timeZone } = useScheduledPresentation();
  return <li className="scheduled-execution-record" data-run-id={run.id}><div className="scheduled-run-top"><time dateTime={run.claimedAt} title={`实际触发：${run.claimedAt} · 计划：${run.scheduledAt}`}>{executionTime(run.claimedAt, timeZone)}</time><RunState run={run}/>{run.sessionId && <WandButton size="small" kind="ghost" onClick={() => onSession(run)}>查看会话<WandIcon name="chevron" size={12}/></WandButton>}</div>
    <code title="本次执行时保存的目录">{run.cwd || "未解析执行目录"}</code>{run.error && <p className="scheduled-run-error" data-tone={run.executionStatus}>{run.error}</p>}
  </li>;
}

function ExecutionHistoryView({ task, records, active, focusRun, latestRun, range, generatedAt, loading, error, onExpand, onSession }: {
  task: ScheduledTaskSummary; records: readonly ScheduledTaskRunFactView[]; active: boolean; focusRun?: ScheduledTaskRunFactView; latestRun?: ScheduledTaskRunFactView | null; range?: ScheduledTaskReadRange; generatedAt?: string; loading: boolean; error: string; onExpand(): void; onSession(run: ScheduledTaskRunFactView): void;
}) {
  const context = useScheduledPresentation();
  const timeZone = context.timeZone;
  const now = React.useMemo(() => generatedAt ? new Date(generatedAt) : context.now, [generatedAt, context.now]);
  const [open, setOpen] = React.useState(false);
  const [visited, setVisited] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const latest = latestExecution(records);
  const shownRun = focusRun ?? latestRun ?? latest;
  const days = React.useMemo(() => executionDays(records, now, task.createdAt, timeZone), [records, task.createdAt, now, timeZone]);
  const [focusKey, setFocusKey] = React.useState(() => shownRun ? dateKey(shownRun.claimedAt, timeZone) : dateKey(now, timeZone));
  const trigger = React.useRef<HTMLButtonElement>(null);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>());
  const id = React.useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const openSession = (run: ScheduledTaskRunFactView) => { setOpen(false); onSession(run); };
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
  return <section className="scheduled-detail-history" aria-label={`${task.title}的执行记录`}>
    <header><h2>{focusRun ? "本次执行" : "最近执行"}</h2><WandButton ref={trigger} size="small" kind="ghost" className="scheduled-history-toggle" aria-expanded={open && active} aria-controls={id} onClick={() => { if (open) close(); else { setVisited(true); setSelected(null); setOpen(true); onExpand(); } }}>执行情况<span className="scheduled-task-chevron" data-expanded={open && active}><WandIcon name="chevronDown" size={13}/></span></WandButton></header>
    {shownRun ? <ol className="scheduled-latest-record" aria-label={focusRun ? "选中的一次执行" : "最近一次执行"}><ExecutionRecord run={shownRun} onSession={openSession}/></ol> : <p className="scheduled-secondary">尚未执行；到达计划时间后会保留记录。</p>}
    <div id={id} className="scheduled-history-expansion" data-open={open && active} inert={!open || !active} aria-hidden={!open || !active}><div>{visited && (range ? <div className="scheduled-execution-heatmap" aria-label="近12周执行热力图">
      <div className="scheduled-heat-summary"><span>近 12 周</span><span>{loading ? "刷新中 · " : ""}已提供 {records.length} 条记录</span></div>
      <div className="scheduled-heat-scroll"><div className="scheduled-heat-months" aria-hidden="true"><span/>{days.filter((_, index) => index % 7 === 0).map((day, week) => <span key={day.key}>{week === 0 || day.key.slice(0, 7) !== days[(week - 1) * 7].key.slice(0, 7) ? `${Number(day.key.slice(5, 7))}月` : ""}</span>)}</div>
        <div className="scheduled-heat-layout"><div className="scheduled-heat-weekdays" aria-hidden="true">{["一", "", "三", "", "五", "", "日"].map((day, index) => <span key={index}>{day}</span>)}</div>
          <div className="scheduled-heat-board" role="group" aria-label="日期方格，左右换周，上下换日">{days.map((day, index) => <Tooltip key={day.key} title={dayDescription(day)}><WandButton className="scheduled-heat-cell" kind="ghost" ref={node => { if (node) buttons.current.set(day.key, node); else buttons.current.delete(day.key); }} style={{ gridColumn: Math.floor(index / 7) + 1, gridRow: index % 7 + 1 }} data-date={day.key} data-outcome={day.outcome} data-level={day.level} aria-label={dayDescription(day)} aria-pressed={selected === day.key} disabled={!day.available} tabIndex={focusKey === day.key ? 0 : -1} onFocus={() => setFocusKey(day.key)} onKeyDown={event => moveFocus(event, index)} onClick={() => setSelected(day.key)}>{day.outcome === "mixed" ? "±" : day.outcome === "unknown" ? "?" : day.outcome === "skipped" ? "−" : null}</WandButton></Tooltip>)}</div>
        </div>
      </div>
      <div className="scheduled-heat-legend" aria-label="热力图图例">{(["completed", "failed", "running", "unknown", "mixed", "skipped", "empty"] as const).map(state => <span key={state}><i data-outcome={state}/>{state === "running" ? "运行/等待" : labels[state]}</span>)}</div>
      <p className="scheduled-heat-help">按实际触发日归类。{range.complete ? "空白表示当前范围无记录。" : "范围可能不完整，空白仅表示未提供记录。"}{range.invalidDates ? ` ${range.invalidDates}条旧记录时间待确认。` : ""}点日期查看，方向键可移动。</p>{error && <Alert type="warning" showIcon title={error}/>}
      {selectedDay && <section className="scheduled-heat-day-detail" aria-label={`${selectedDay.key}执行记录`}><header><h3>{selectedDay.key}</h3><span>{selectedDay.records.length ? `${selectedDay.records.length} 次` : "未提供记录"}</span></header>{selectedDay.records.length ? <ol>{selectedDay.records.map(run => <ExecutionRecord key={run.id} run={run} onSession={openSession}/>)}</ol> : <p className="scheduled-secondary">已提供的记录中没有这一天，不能据此判定成功或失败。</p>}</section>}
    </div> : <div role="status">{error ? <Alert type="error" showIcon title={error} action={<WandButton size="small" onClick={onExpand}>重新读取</WandButton>}/> : <><Spin size="small"/>正在读取执行情况…</>}</div>)}</div></div>
  </section>;
}


/** Read owner: history loads only after explicit expansion, aborts on hide/task
 * change, and never turns a failed/partial response into empty successful days. */
export function ExecutionHistory({ task, active, focusRun, onSession }: {
  task: ScheduledTaskSummary; active: boolean; focusRun?: ScheduledTaskRunFactView; onSession(run: ScheduledTaskRunFactView): void;
}) {
  const { timeZone } = useScheduledPresentation();
  const [requested, setRequested] = React.useState(false), [generation, setGeneration] = React.useState(0);
  const [data, setData] = React.useState<ScheduledTaskActivityResponse | null>(null);
  const [loading, setLoading] = React.useState(false), [error, setError] = React.useState("");
  React.useEffect(() => { if (!active) setRequested(false); }, [active]);
  React.useEffect(() => {
    if (!active || !requested) return;
    let alive = true, pending: AbortController | null = null;
    const read = async () => {
      if (pending || document.visibilityState === "hidden") return;
      const controller = new AbortController(); pending = controller; setLoading(true);
      try {
        const result = await scheduledTasksRepository.activity(task.id, timeZone, controller.signal);
        if (alive && !controller.signal.aborted) { setData(result); setError(""); }
      } catch (failure) {
        if (alive && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "执行情况读取失败");
      } finally { if (pending === controller) { pending = null; if (alive) setLoading(false); } }
    };
    void read(); const timer = setInterval(() => { void read(); }, 15_000);
    return () => { alive = false; clearInterval(timer); pending?.abort(); };
  }, [active, requested, generation, task.id, timeZone]);
  return <ExecutionHistoryView task={task} records={data?.runs ?? []} latestRun={task.lastRun} active={active}
    focusRun={focusRun} range={data?.range} generatedAt={data?.generatedAt} loading={loading} error={error}
    onExpand={() => { setRequested(true); setGeneration(value => value + 1); }} onSession={onSession}/>;
}
