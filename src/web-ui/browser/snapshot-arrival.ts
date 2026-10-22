// A generation-scoped wait for the subscription's initial snapshot. The UI renders
// on the WS event itself; this deadline only controls the HTTP fallback request.
const arrivals = new Map<string, Set<() => void>>();
export function snapshotArrived(id: string): void { for (const done of arrivals.get(id) ?? []) done(); }
export function waitForSnapshot(id: string, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const listeners = arrivals.get(id) ?? new Set(); arrivals.set(id, listeners);
    const finish = (received: boolean): void => { clearTimeout(timer); listeners.delete(done); if (!listeners.size) arrivals.delete(id); resolve(received); };
    const done = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    listeners.add(done);
  });
}
