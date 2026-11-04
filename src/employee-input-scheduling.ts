import type { SessionSnapshot } from "./types.js";
import type { WandTaskPriority } from "./task-types.js";

/** 来源只由可信发送入口填写，不接受请求正文自报优先级。旧队列保守按任务处理。 */
export interface EmployeeInputScheduling {
  origin?: import("./task-types.js").TaskCommentOrigin;
  source: "user" | "task";
  enqueuedAt: string;
  /** Stable tie-breaker for inputs accepted in the same millisecond. */
  sequence?: number;
  /** Native question visible at acceptance; never retarget an earlier queued input as its answer. */
  nativeQuestionId?: string;
  /** An explicit refusal waits for the next turn instead of retrying the same control RPC. */
  nativeSteeringRejected?: boolean;
  /** Only an explicit immediate/promotion action may steer a running Qoder turn. */
  nativeSteeringRequested?: boolean;
  /** Explicit Codex rejection stays queued until the user edits or retrieves it. */
  nativeInputError?: string;
  /** Private native reservation; retained in the durable queue until commit. */
  handoff?: import("./pi-native-input.js").PiInputHandoff;
  /** Durable identity used to remove exactly the accepted queue item at dispatch. */
  acceptanceId?: string;
  /** In-memory correlation only; JSON persistence deliberately omits functions. */
  teamRequestStarted?: (sessionId: string, requestId: string) => void;
}

export function queuedInputScheduling(session: SessionSnapshot): EmployeeInputScheduling[] {
  return (session.queuedMessages ?? []).map((_, index) => session.queuedInputScheduling?.[index]
    ?? { source: "task", enqueuedAt: session.startedAt });
}

export function employeeInputPriority(source: EmployeeInputScheduling["source"], priority?: WandTaskPriority): number {
  if (source === "user") return 5;
  switch (priority) {
    case "urgent": return 4;
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 0;
  }
}

export interface EmployeeInputAdmission {
  /** 显式「立即发送」跳过并发槽位与优先级比较，但仍校验员工归属是否有效。 */
  canStart(session: SessionSnapshot, scheduling: EmployeeInputScheduling, immediate?: boolean): boolean;
  schedule(employeeId: string): void;
}
