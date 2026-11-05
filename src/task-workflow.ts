import { HttpError } from "./http-error.js";
import { taskAiVerified, taskWorkflowStage, type TaskWorkflowAction, type TaskWorkflowInput, type WandTask } from "./task-types.js";
import type { WandTaskPatch } from "./storage/internal.js";

export const TASK_WORKFLOW_ACTIONS: readonly TaskWorkflowAction[] = ["progress", "block", "submit", "pass", "fail", "return", "accept"];
export type TaskWorkflowActor = { kind: "user" } | { kind: "employee"; sessionId: string; employeeId: string | null };
const fail = (message: string): never => { throw new HttpError(409, "task_workflow_conflict", message); };

export function parseTaskWorkflowInput(value: unknown): TaskWorkflowInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "bad_request", "需要工作流动作。");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["action", "requestId", "expectedUpdatedAt", "evidence", "blocker", "selfTest"].includes(key))) throw new HttpError(400, "bad_request", "工作流包含不支持的字段。");
  if (!TASK_WORKFLOW_ACTIONS.includes(body.action as TaskWorkflowAction)
    || typeof body.requestId !== "string" || !/^[a-zA-Z0-9:_-]{8,80}$/.test(body.requestId)
    || typeof body.expectedUpdatedAt !== "string" || !body.expectedUpdatedAt
    || typeof body.evidence !== "string" || body.evidence.length > 16000
    || typeof body.blocker !== "string" || body.blocker.length > 4000) throw new HttpError(400, "bad_request", "工作流动作、请求标识、任务版本或交付证据无效。");
  let selfTest: TaskWorkflowInput["selfTest"];
  if (body.selfTest !== undefined) {
    if (!Array.isArray(body.selfTest) || !body.selfTest.length || body.selfTest.length > 100) throw new HttpError(400, "bad_request", "自测清单需要 1–100 项完成标准及通过证据。");
    selfTest = body.selfTest.map((check: unknown) => {
      if (!check || typeof check !== "object" || Array.isArray(check)) throw new HttpError(400, "bad_request", "自测项无效。");
      const item = check as Record<string, unknown>;
      if (typeof item.criterion !== "string" || !item.criterion.trim() || item.criterion.length > 1000
        || typeof item.evidence !== "string" || !item.evidence.trim() || item.evidence.length > 2000) throw new HttpError(400, "bad_request", "每个自测项必须有完成标准 criterion 和实际通过证据 evidence。");
      return { criterion: item.criterion.trim(), evidence: item.evidence.trim() };
    });
    if (JSON.stringify(selfTest).length > 16000) throw new HttpError(400, "bad_request", "自测清单过长，请保留结果及证据位置。");
  }
  return { action: body.action as TaskWorkflowAction, requestId: body.requestId, expectedUpdatedAt: body.expectedUpdatedAt, evidence: body.evidence.trim(), blocker: body.blocker.trim(), ...(selfTest ? { selfTest } : {}) };
}

/** Pure transition; storage owns CAS, live execution checks, receipts and atomic history. */
export function taskWorkflowPatch(task: WandTask, children: WandTask[], input: TaskWorkflowInput, actor: TaskWorkflowActor, now: string): WandTaskPatch {
  const { action, evidence, blocker } = input;
  const stage = taskWorkflowStage(task.status), revision = task.deliveryRevision ?? 0;
  if (action === "progress") {
    if (stage !== "doing" || !evidence && !blocker) fail("进展回填仅适用于执行中任务，并需要证据或阻塞原因。");
    return { acceptance: { evidence, blocker, acceptedAt: null } };
  }
  if (action === "block") {
    if (!["doing", "review"].includes(stage) || !evidence || !blocker) fail("仅执行或验收中的明确外部阻塞可暂停；evidence 写已尝试的解决办法，blocker 写无法自行解除的条件及需要的最小帮助。");
    return { acceptance: { ...task.acceptance, evidence, blocker, acceptedAt: null, blockerKind: "external" } };
  }
  if (actor.kind !== "user" && (action === "accept" || action === "return")) throw new HttpError(403, "forbidden", "AI 只能提交交付或回填验收，不能代替人工确认或退回。");
  if ((action === "submit" && stage !== "doing") || ((action === "pass" || action === "fail") && stage !== "review") || ((action === "accept" || action === "return") && stage !== "ready")) fail("任务阶段已变化，请刷新并核对，不能跨阶段推进。");
  if (["submit", "pass", "accept"].includes(action) && (!evidence || blocker)) fail("需要交付证据，且不能遗留缺口或未验证项。");
  if ((action === "fail" || action === "return") && !blocker) fail("失败、无法验证或退回必须写明原因。");
  const acceptance = { evidence, blocker, acceptedAt: null, ...(task.acceptance?.selfTest ? { selfTest: task.acceptance.selfTest } : {}) };
  if (action === "submit" && children.some(child => !["review", "ready", "archived"].includes(taskWorkflowStage(child.status)) || child.acceptance?.blocker?.trim())) fail("仍有实现子任务尚未交付或存在阻塞，不能提交主需求验收。");
  if (action === "submit") {
    if (actor.kind === "employee" && !input.selfTest?.length) fail('提交前必须逐项自测通过：补充 selfTest:[{"criterion":"完成标准","evidence":"实际通过结果及证据位置"}]；自测失败继续修复，不得送验。');
    return { status: "review", deliveryRevision: revision + 1, verification: null,
      acceptance: { evidence, blocker, acceptedAt: null, ...(input.selfTest ? { selfTest: input.selfTest } : {}) } };
  }
  if (action === "return") return { status: "doing", deliveryRevision: revision + 1, verification: null, acceptance };
  if (action === "accept") {
    if (!taskAiVerified(task)) fail("没有针对当前交付的 AI 验收通过记录，请先完成验收。");
    if (children.some(child => !taskAiVerified(child))) fail("仍有子任务没有当前交付的验收通过记录。");
    return { status: "archived", acceptance: { evidence, blocker: "", acceptedAt: now, confirmedRevision: revision } };
  }
  if (action === "pass" && children.some(child => !["review", "ready", "archived"].includes(taskWorkflowStage(child.status)) || child.acceptance?.blocker?.trim())) fail("仍有子任务未交付或存在阻塞，不能通过主目标整体验收。");
  return { status: action === "pass" ? "archived" : "doing", acceptance,
    verification: { verdict: action === "pass" ? "passed" : "failed", evidence, blocker, reviewedAt: now, revision,
      sourceSessionId: actor.kind === "employee" ? actor.sessionId : null, reviewerId: actor.kind === "employee" ? actor.employeeId : null } };
}
