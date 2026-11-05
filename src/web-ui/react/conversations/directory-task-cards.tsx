import * as React from "react";
import { Alert, Typography } from "antd";
import { WandButton, WandIcon } from "../ui";
import { SidebarRowMenu } from "../workspaces/sidebar-row-menu";
import { updatePageRoute } from "../../page-route";
import type { UnifiedSidebarEntry, UnifiedSidebarModel } from "./unified-sidebar-model";
import { createRequestId, requestJson } from "../http-adapter";
import { isSessionRunning } from "../workspaces/sidebar-display-mode";
import { issueStatusLabel } from "../issues/task-board-agent";
import { CONVERSATION_TASK_STAGES } from "./list-filters";
import { taskWorkflowStage } from "../../../task-types";
import type { WandTask, WandTaskStatus } from "../../../task-types";
import type { TaskSummary } from "../workspaces/types";

const OrganizationReviewDialog = React.lazy(() => import("./organization-review-dialog"));
function openCardMenu(event: React.MouseEvent<HTMLButtonElement>, open: boolean, close: () => void): void {
  event.stopPropagation();
  if (open) { close(); return; }
  const bounds = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.right, clientY: bounds.bottom, button: 2 }));
}

function TaskCard({ task, entries, history, renderRow, searching, selectedId, onChanged }: {
  task?: TaskSummary; entries: UnifiedSidebarEntry[]; history: UnifiedSidebarEntry[]; renderRow(entry: UnifiedSidebarEntry): React.ReactNode; searching: boolean; selectedId?: string | null; onChanged(): void;
}) {
  const running = entries.some(entry => isSessionRunning(entry.session));
  const [open, setOpen] = React.useState<boolean | null>(null);
  React.useEffect(() => { setOpen(null); }, [running]);
  const [menu, setMenu] = React.useState(false), [busy, setBusy] = React.useState(false), [feedback, setFeedback] = React.useState(""), [error, setError] = React.useState("");
  const pending = React.useRef(false);
  const request = React.useRef<{ status: WandTaskStatus; expectedUpdatedAt: string; requestId: string } | null>(null);
  const changeStatus = async (status: WandTaskStatus, retry = false) => {
    if (!task?.boardTaskId || pending.current) return;
    pending.current = true; setMenu(false); setBusy(true); setError(""); setFeedback("正在停止旧执行并修改状态…");
    try {
      if (!retry || !request.current) {
        const current = await requestJson<WandTask>(`/api/wand-tasks/${task.boardTaskId}`);
        request.current = { status, expectedUpdatedAt: current.updatedAt, requestId: createRequestId() };
      }
      const result = await requestJson<{ receipt: { stoppedSessions: number; cancelledDispatches: number } }>(`/api/wand-tasks/${task.boardTaskId}/change-status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.current),
      });
      setFeedback(`已改为${issueStatusLabel(status)}；停止 ${result.receipt.stoppedSessions} 个执行，取消 ${result.receipt.cancelledDispatches} 条旧派发，等待下一轮巡检。`); request.current = null;
    } catch (cause) { setFeedback(""); setError(cause instanceof Error ? cause.message : "状态修改未确认，请查询本次结果。"); }
    finally { pending.current = false; setBusy(false); onChanged(); }
  };
  const count = task?.queuedDispatchCount ?? 0;
  const stageLabel = task?.boardTaskStatus ? CONVERSATION_TASK_STAGES.find(option => option.value === taskWorkflowStage(task.boardTaskStatus!))?.label ?? "未记录阶段" : "未记录阶段";
  const expanded = searching || (open ?? running);
  const header = <div className="sidebar-task-card-header"><button type="button" className="sidebar-task-card-toggle" aria-expanded={expanded} onClick={() => {
      setOpen(!expanded);
    }}><WandIcon name={expanded ? "chevronDown" : "chevron"} size={12}/><span><strong title={task?.name}>{task?.name || "未分组会话"}</strong></span></button>
      {task ? <span className="sidebar-task-card-status" data-stage={task.boardTaskStatus || "unknown"} title={`任务状态：${stageLabel}`} aria-label={`任务状态：${stageLabel}`}>{stageLabel}</span> : null}
      {task?.boardTaskId ? <WandButton kind="ghost" size="small" disabled={busy} aria-label={`${task.name}的任务操作`} onClick={event => openCardMenu(event, menu, () => setMenu(false))}><WandIcon name="more" size={14}/></WandButton> : null}
    </div>;
  return <section className="sidebar-task-card" data-task-card={task?.id} aria-busy={busy}>
    {task?.boardTaskId ? <SidebarRowMenu row={header} open={menu} onOpenChange={setMenu} title={task.name} label="任务卡片操作" className="task-status-card-menu" disabled={busy}
      description="修改状态会停止本任务及子任务的 Agent，取消旧派发，等待下一轮巡检。"
      menu={{ items: [{ key: "detail", label: "查看任务详情" }, { key: "status", label: "修改任务状态", children: (["backlog", "todo", "doing", "archived"] as const).map(status => ({ key: status, label: issueStatusLabel(status), disabled: status === task.boardTaskStatus })) },
        { key: "workflow", label: "提交交付 / 独立验收…" }], onClick: ({ key }) => { setMenu(false); if (key === "detail" || key === "workflow") updatePageRoute({ view: "issues", task: task.boardTaskId! }); else void changeStatus(key as WandTaskStatus); } }}/ > : header}
    {error ? <div className="sidebar-task-feedback"><Alert type="error" title={error}/>{request.current ? <WandButton size="small" disabled={busy} onClick={() => void changeStatus(request.current!.status, true)}>查询 / 重试本次修改</WandButton> : null}</div> : feedback ? <p className="sidebar-task-feedback" role="status">{feedback}</p> : null}
    {expanded ? <div className="sidebar-task-card-sessions">{[...entries].sort((a, b) => Number(isSessionRunning(b.session)) - Number(isSessionRunning(a.session))).map(renderRow)}
      {history.length ? <details className="sidebar-task-history"><summary>已归档会话 · {history.length}</summary>{history.map(renderRow)}</details> : null}
      {count > 0 && task?.boardTaskId ? <button className="sidebar-task-queued" type="button" onClick={() => updatePageRoute({ view: "issues", task: task.boardTaskId! })}><WandIcon name="clock" size={14}/>{count} 条派发排队中 · 查看任务</button> : null}
    </div> : null}
  </section>;
}

export function DirectoryTaskCards({ rows, allRows, queued = [], model, directory, renderRow, selectedId }: {
  rows: UnifiedSidebarEntry[]; allRows: UnifiedSidebarEntry[]; queued?: TaskSummary[]; model: UnifiedSidebarModel; directory: string;
  renderRow(entry: UnifiedSidebarEntry): React.ReactNode; selectedId?: string | null;
}) {
  const [menu, setMenu] = React.useState(false), [review, setReview] = React.useState(false), [open, setOpen] = React.useState<boolean | null>(null);
  const [hasReview, setHasReview] = React.useState(() => { try { return !!sessionStorage.getItem(`wand.organization.review:${directory}`); } catch { return false; } });
  const buckets = new Map<string, { task: TaskSummary; entries: UnifiedSidebarEntry[] }>();
  for (const row of rows) if (row.task) {
    const bucket = buckets.get(row.task.id) ?? { task: row.task, entries: [] }; bucket.entries.push(row); buckets.set(row.task.id, bucket);
  }
  for (const task of queued) if (!buckets.has(task.id)) buckets.set(task.id, { task, entries: [] });
  const archivedBuckets = new Map<string, { task: TaskSummary; entries: UnifiedSidebarEntry[] }>();
  if (!model.query && model.facets.runtime === "all" && model.facets.taskStage === "all") for (const row of allRows) if (row.task && row.archived && !buckets.has(row.task.id)) {
    const bucket = archivedBuckets.get(row.task.id) ?? { task: row.task, entries: [] }; bucket.entries.push(row); archivedBuckets.set(row.task.id, bucket);
  }
  const ungrouped = rows.filter(row => !row.task), candidates = allRows.filter(row => !row.task && !row.archived && !row.conversation);
  const title = "未分组会话";
  const ungroupedRunning = ungrouped.some(entry => isSessionRunning(entry.session));
  const ungroupedOpen = !!model.query || (open ?? ungroupedRunning);
  React.useEffect(() => { setOpen(null); }, [ungroupedRunning]);
  return <div className="directory-task-cards">
    {[...buckets.values()].sort((a, b) => Number(b.entries.some(entry => isSessionRunning(entry.session))) - Number(a.entries.some(entry => isSessionRunning(entry.session)))).map(bucket => <TaskCard key={bucket.task.id} {...bucket} history={allRows.filter(row => row.task?.id === bucket.task.id && row.archived && !rows.some(shown => shown.session.id === row.session.id))} renderRow={renderRow} searching={!!model.query} selectedId={selectedId} onChanged={model.refresh}/>)}
    {ungrouped.length ? <section className="sidebar-task-card sidebar-task-card-ungrouped" style={{ order: ungroupedRunning ? -1 : undefined }}>
      <SidebarRowMenu title="未分组会话" label="未分组会话的操作" open={menu} onOpenChange={setMenu}
        row={<div className="sidebar-task-card-header"><button type="button" className="sidebar-task-card-toggle" aria-expanded={ungroupedOpen} onClick={() => setOpen(!ungroupedOpen)}><WandIcon name={ungroupedOpen ? "chevronDown" : "chevron"} size={12}/><strong>{title}</strong></button><WandButton kind="ghost" size="small" aria-label="未分组会话的操作" onClick={event => openCardMenu(event, menu, () => setMenu(false))}><WandIcon name="more" size={16}/></WandButton></div>}
        menu={{ items: [{ key: "organize", label: "自动归类…", disabled: !candidates.length, icon: <WandIcon name="folder"/> }, { key: "toggle", label: ungroupedOpen ? "收起会话" : "展开会话" }],
          onClick: ({ key }) => { setMenu(false); if (key === "organize") setReview(true); else setOpen(!ungroupedOpen); } }}/>
      {ungroupedOpen ? <div className="sidebar-task-card-sessions">{[...ungrouped].sort((a, b) => Number(isSessionRunning(b.session)) - Number(isSessionRunning(a.session))).map(renderRow)}</div> : null}
    </section> : null}
    {archivedBuckets.size ? <details className="sidebar-task-history"><summary>已归档 · {archivedBuckets.size} 个任务的历史会话</summary>{[...archivedBuckets.values()].map(bucket => <TaskCard key={bucket.task.id} {...bucket} history={[]} renderRow={renderRow} searching={false} selectedId={selectedId} onChanged={model.refresh}/>)}</details> : null}
    {hasReview ? <WandButton kind="ghost" size="small" onClick={() => setReview(true)}><WandIcon name="history" size={14}/>查看最近整理 / 撤销</WandButton> : null}
    {review ? <React.Suspense fallback={<Typography.Text role="status">正在打开整理预览…</Typography.Text>}><OrganizationReviewDialog directory={directory} sessionIds={candidates.map(row => row.session.id)} onClose={() => { setReview(false); try { setHasReview(!!sessionStorage.getItem(`wand.organization.review:${directory}`)); } catch { /* optional recovery */ } }} onChanged={model.refresh}/></React.Suspense> : null}
  </div>;
}
