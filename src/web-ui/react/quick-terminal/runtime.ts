export interface QuickTerminalEvent { sessionId?: string; type: string; data?: { status?: string; cwd?: string }; }
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
