import type { SessionSnapshot } from "./types.js";
import type { WandTaskPriority } from "./task-types.js";

/** 来源只由可信发送入口填写，不接受请求正文自报优先级。旧队列保守按任务处理。 */
export interface EmployeeInputScheduling {
  source: "user" | "task";
  enqueuedAt: string;
  /** Stable tie-breaker for inputs accepted in the same millisecond. */
  sequence?: number;
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
