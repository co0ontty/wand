/** Public projection: no daemon credentials, paths, process IDs or raw failures. */
export interface DaemonMaintenanceStatus {
  pending: boolean;
  phase: "idle" | "waiting" | "updating" | "retrying";
  /** HTTP view only; lifecycle status has no caller-specific permissions. */
  canForceUpdate?: boolean;
}

export function daemonMaintenanceMessage(status: DaemonMaintenanceStatus): string {
  if (!status.pending) return "";
  if (status.phase === "updating") return "底层组件正在自动更新。无需操作。";
  if (status.phase === "retrying") return "底层组件更新尚未完成，系统会自动重试。无需操作。";
  return "底层组件更新正在等待执行与队列结束，届时自动更新。无需操作。";
}
