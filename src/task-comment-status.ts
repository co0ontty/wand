/**
 * 任务评论里员工执行状态的统一文案。
 *
 * 三端（Web / iOS / Android）必须用同一份词表：状态名是用户读到的唯一真相，
 * 各端自己写一份迟早会漂移。`statusLabels` 是词表，`statusTone` 只给 Web 的标签色。
 */

/** 状态 → 用户读到的文案。未知状态不给猜测，统一回落成「状态未确认」。 */
export const statusLabels: Record<string, string> = {
  paused: "已暂停", queued: "排队中", pending: "等待确认", accepted: "已创建执行", running: "执行中", blocked: "等待审批",
  idle: "本轮已结束", exited: "会话已退出", stopped: "已停止", failed: "执行失败",
  done: "已完成", unknown: "送达未知 · 不会重放", history: "历史会话", unavailable: "会话不可用",
};

/** 状态 → Web 标签色；其余端不用颜色，只用文案。 */
export const statusTones: Record<string, string> = {
  paused: "default", queued: "processing", running: "processing", done: "success", idle: "default", failed: "error", stopped: "warning",
  blocked: "warning", unknown: "warning", pending: "warning", accepted: "default",
  history: "default", unavailable: "default",
};

/** 未知状态的统一回落文案。 */
export const unknownStatusLabel = "状态未确认";

export function statusLabel(status: string | null | undefined): string {
  if (!status) return unknownStatusLabel;
  return statusLabels[status] ?? unknownStatusLabel;
}
