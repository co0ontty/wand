import { taskAiVerified, taskHumanAccepted, taskWorkflowStage, type TaskAcceptance, type WandTask } from "../../../task-types";
import type { IssueSessionSummary } from "./task-board-repository";

type TaskDeliveryState = Pick<WandTask, "status" | "acceptance" | "verification" | "deliveryRevision"> & Partial<Pick<WandTask, "id" | "identifier" | "title" | "parentTaskId">>;
const validRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const stamp = (value: unknown): string => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "时间未知";

/** Read-only projection. Never use it to grant workflow actions or infer execution activity. */
function ownDelivery(task: TaskDeliveryState) {
  const revision = task.deliveryRevision, verification = task.verification, acceptance = task.acceptance;
  const current = validRevision(revision) && verification?.revision === revision;
  const failed = current && verification?.verdict === "failed";
  const passed = current && taskAiVerified(task);
  const confirmed = validRevision(revision) && acceptance?.confirmedRevision === revision && !!acceptance.acceptedAt;
  const human = confirmed && stamp(acceptance?.acceptedAt) !== "时间未知" && taskHumanAccepted(task);
  const blocker = text(acceptance?.blocker) || (current ? text(verification?.blocker) : "") || (failed ? "独立验收未通过，具体缺口未记录" : "");
  const conflict = !!verification && (!validRevision(verification.revision) || validRevision(revision) && verification.revision > revision)
    || !!acceptance?.acceptedAt && (!validRevision(acceptance.confirmedRevision) || validRevision(revision) && acceptance.confirmedRevision > revision)
    || confirmed && (!human || failed) || passed && !!blocker
    || current && verification?.verdict === "passed" && !passed;
  let label: string, next: string, tone: "warning" | "success" | "secondary" = "secondary";
  let completed = false;
  if (!validRevision(revision)) { label = "交付版本未记录，验收待核对"; next = "核对交付版本与验收记录"; tone = "warning"; }
  else if (conflict) { label = "验收记录冲突 · 待核对"; next = "核对当前版本的失败、通过与确认事实"; tone = "warning"; }
  else if (failed || blocker) { label = failed ? "独立验收未通过" : acceptance?.blockerKind === "external" ? "外部阻塞" : "有验收缺口"; next = acceptance?.blockerKind === "external" ? "等待解除明确外部条件" : "待补齐缺口、自测后重新提交"; tone = "warning"; }
  else if (human || task.status === "archived" && passed) { label = human ? "人工已确认 · 已完成" : "独立验收通过 · 已自动完成"; next = "保留交付与验收记录"; completed = true; tone = "success"; }
  else if (task.status === "archived") { label = "历史归档 · 验收未确认"; next = "核对当前交付的验收证明"; }
  else if (passed) { label = task.status === "ready" ? "AI 已通过 · 等你确认" : "独立验收通过记录 · 待核对阶段"; next = task.status === "ready" ? "核对证据后确认归档（兼容流程）" : "核对任务阶段与验收记录"; tone = task.status === "ready" ? "success" : "warning"; }
  else if (taskWorkflowStage(task.status) === "review") { label = "等待独立验收"; next = "由独立验收核对当前交付"; }
  else if (task.status === "ready") { label = "验收待核对"; next = "补齐当前版本的可信通过记录"; tone = "warning"; }
  else { label = text(acceptance?.evidence) ? "进展已记录 · 尚未提交验收" : task.status === "doing" ? "尚未提交验收" : task.status === "backlog" ? "待立项 · 尚未提交验收" : "尚未提交验收"; next = "完成实现与自测后提交独立验收"; }
  const records: Array<{ label: string; evidence: string; source: string }> = [];
  if (verification) records.push({ label: `${current ? "当前" : validRevision(revision) && validRevision(verification.revision) && verification.revision < revision ? "历史" : "待核对"}验收 v${verification.revision} · ${verification.verdict}`, evidence: [text(verification.evidence), text(verification.blocker)].filter(Boolean).join("；"), source: `验收来源：${[verification.reviewerId, verification.sourceSessionId].filter(Boolean).join(" · ") || "来源未记录"} · 验收时间：${stamp(verification.reviewedAt)}` });
  if (acceptance && (text(acceptance.evidence) || text(acceptance.blocker) || acceptance.acceptedAt)) records.push({ label: acceptance.acceptedAt ? `${confirmed ? "当前" : "历史"}人工确认记录` : taskWorkflowStage(task.status) === "review" ? "交付记录" : "进展/缺口记录（不代表提交）", evidence: [text(acceptance.evidence), text(acceptance.blocker)].filter(Boolean).join("；"), source: `来源未记录 · ${acceptance.acceptedAt ? `人工确认时间：${stamp(acceptance.acceptedAt)}` : "时间未知"}` });
  return { label, next, tone, completed, completionFact: human ? "人工已确认" : "独立验收通过", verified: passed && !conflict && !blocker, blocker, external: !!blocker && acceptance?.blockerKind === "external", records, source: records.map(record => `${record.label} · ${record.source}`).join("；") || "来源未记录 · 时间未知" };
}

export function resolveTaskDelivery(task: TaskDeliveryState, displayTasks: readonly TaskDeliveryState[] = []) {
  const own = ownDelivery(task);
  const gaps: Array<{ task: TaskDeliveryState; blocker: string; external: boolean }> = [];
  const byParent = new Map<string, TaskDeliveryState[]>();
  for (const item of displayTasks) if (item.parentTaskId) byParent.set(item.parentTaskId, [...(byParent.get(item.parentTaskId) ?? []), item]);
  const seen = new Set<string>(task.id ? [task.id] : []);
  const pending = task.id ? [...(byParent.get(task.id) ?? [])] : [];
  let cycle = false;
  while (pending.length) {
    const child = pending.pop()!;
    if (!child.id) continue;
    if (seen.has(child.id)) { cycle = true; continue; }
    seen.add(child.id);
    const state = ownDelivery(child);
    if (!state.completed) gaps.push({ task: child, blocker: state.blocker || state.label, external: state.external });
    pending.push(...(byParent.get(child.id) ?? []));
  }
  if (cycle) gaps.push({ task, blocker: "子任务关系存在循环，待核对", external: false });
  const label = gaps.length ? `${own.completed ? `${own.completionFact} · 整体未完成` : own.label} · ${gaps.length} 项后代缺口` : own.label;
  return { ...own, label, completed: own.completed && !gaps.length, tone: gaps.length ? "warning" as const : own.tone,
    next: gaps.length ? "补齐后代缺口后核对整体交付" : own.next, gaps,
    detail: [own.blocker, ...gaps.map(gap => `${gap.task.identifier ?? gap.task.id}：${gap.external ? "外部阻塞" : "待补齐"} · ${gap.blocker}`)].filter(Boolean).join("；") };
}

export function taskWorkLabel(task: TaskDeliveryState, displayTasks: readonly TaskDeliveryState[] = []): string {
  return resolveTaskDelivery(task, displayTasks).label;
}
export function taskReviewLabel(task: TaskDeliveryState, displayTasks: readonly TaskDeliveryState[] = []): string {
  return resolveTaskDelivery(task, displayTasks).label;
}
export function taskAcceptanceLabel(acceptance?: TaskAcceptance | null, task?: TaskDeliveryState, displayTasks: readonly TaskDeliveryState[] = []): string {
  return resolveTaskDelivery(task ?? { status: "doing", acceptance }, displayTasks).label;
}

export function taskSessionActivity(session: IssueSessionSummary): string {
  if (session.archived) return "已归档";
  if (session.source !== "structured" && session.source !== "pty") {
    if (session.status === "failed") return "历史失败 · 当前活动未确认";
    if (session.status === "stopped") return "历史停止 · 当前活动未确认";
    if (session.status === "exited") return "历史结束 · 当前活动未确认";
    return "当前活动未确认";
  }
  if (session.permissionBlocked) return "等待授权";
  if (["waiting-input", "waiting_input", "needs_input"].includes(session.status)) return "等待输入";
  // A live turn can also have queued follow-ups; the queue must not hide that turn.
  if (session.source === "structured" && session.inFlight === true
    || session.executionStatus === "running") return "运行中";
  if (session.status === "failed") return "失败";
  if (session.status === "stopped") return "已停止";
  if (session.status === "exited") return "已结束";
  if (session.executionStatus === "queued" || session.status === "queued") return "排队中";
  if (session.status === "idle" || session.source === "structured" && session.inFlight === false
    || session.source === "pty" && session.executionStatus === null) return "空闲";
  return "状态未确认";
}

/** 判定会话是否正在运行；不要拿展示文案做字符串比较。 */
export function taskSessionIsRunning(session: IssueSessionSummary): boolean {
  return taskSessionActivity(session) === "运行中";
}

export function taskSessionSummary(sessions: readonly IssueSessionSummary[]): string {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const state = taskSessionActivity(session);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join(" · ");
}
