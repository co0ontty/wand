export interface PiExecutionWindow {
  sessionId: string;
  toolId: string;
  trigger: HTMLElement | null;
}
let snapshot: PiExecutionWindow | null = null;
const listeners = new Set<() => void>();
function publish(next: PiExecutionWindow | null): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
export const piExecutionController = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot(): PiExecutionWindow | null { return snapshot; },
  open(sessionId: string, toolId: string, trigger: HTMLElement | null = null): void {
    if (snapshot?.sessionId === sessionId && snapshot.toolId === toolId) { this.close(); return; }
    publish({ sessionId, toolId, trigger });
  },
  isOpen(): boolean { return snapshot !== null; },
  close(): void {
    const trigger = snapshot?.trigger;
    publish(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  },
  closeIfOpen(): boolean { if (!snapshot) return false; this.close(); return true; },
};
