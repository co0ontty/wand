/**
 * Queue UI is only needed once a session actually has queued messages.
 * Keep the AntD list/disclosure code out of the shell runtime and apply the
 * latest call per host as soon as the chunk arrives.
 */
type QueueAdapter = typeof import("./queue-view-adapter");
type BarArgs = Parameters<QueueAdapter["paintQueueBar"]>;
type CrossArgs = Parameters<QueueAdapter["paintCrossSessionQueue"]>;

let adapter: QueueAdapter | null = null;
let loading = false;
const barCalls = new Map<HTMLElement, BarArgs>();
const crossCalls = new Map<HTMLElement, CrossArgs>();

function ensureLoaded(): void {
  if (adapter || loading) return;
  loading = true;
  void import("./queue-view-adapter").then(module => {
    adapter = module;
    barCalls.forEach(args => module.paintQueueBar(...args));
    crossCalls.forEach(args => module.paintCrossSessionQueue(...args));
    barCalls.clear();
    crossCalls.clear();
  }).catch(() => { loading = false; });
}

export function paintQueueBar(...args: BarArgs): void {
  ensureLoaded();
  if (adapter) { adapter.paintQueueBar(...args); return; }
  barCalls.set(args[0], args);
}

export function paintCrossSessionQueue(...args: CrossArgs): void {
  ensureLoaded();
  if (adapter) { adapter.paintCrossSessionQueue(...args); return; }
  crossCalls.set(args[0], args);
}

export function clearQueueView(host: HTMLElement): void {
  barCalls.delete(host);
  crossCalls.delete(host);
  if (adapter) adapter.clearQueueView(host);
  else host.replaceChildren();
}
