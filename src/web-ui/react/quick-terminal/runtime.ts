export interface QuickTerminalEvent { sessionId?: string; type: string; data?: { status?: string; cwd?: string }; }
export function terminalConnectionLabel(sessionId: string, event: QuickTerminalEvent): string | undefined {
  if (!sessionId) return;
  // Only transport lifecycle events apply to every terminal. Unscoped errors
  // may belong to a different operation on the shared WebSocket.
  if (event.sessionId && event.sessionId !== sessionId) return;
  if (event.type === "disconnected") return "已断开 · 自动重连中";
  if (event.type === "connected") return "连接中";
  if (event.sessionId !== sessionId) return;
  const ended = ["stopped", "exited", "failed"].includes(event.data?.status || "");
  if (event.type === "init") return ended ? "进程已结束" : "已连接";
  if (event.type === "ended" || (event.type === "status" && ended)) return "进程已结束";
  if (event.type === "status" && (event.data?.status === "running" || event.data?.status === "idle")) return "已连接";
  if (event.type === "resync_required") return "连接中";
  if (event.type === "pty_error" || event.type === "error") return "连接异常";
}
export interface QuickTerminalRuntime {
  mount(sessionId: string, container: HTMLElement): boolean;
  dispose(sessionId: string): void;
  retain(sessionId: string, retained: boolean): void;
  focus(sessionId: string): void;
  reconnect(sessionId: string): void;
  observe(listener: (event: QuickTerminalEvent) => void): () => void;
}
let runtime: QuickTerminalRuntime | null = null;
export function configureQuickTerminalRuntime(next: QuickTerminalRuntime): void { runtime = next; }
export function quickTerminalRuntime(): QuickTerminalRuntime {
  if (!runtime) throw new Error("终端运行时未就绪，请稍后再试。");
  return runtime;
}
