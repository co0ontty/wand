export type UiAuthPhase = "booting" | "anonymous" | "authenticated";
export type UiView = "terminal" | "chat";
export type UiSessionKind = "pty" | "structured";
export type UiProvider = "claude" | "codex" | "opencode" | (string & {});
export type UiSessionStatus = "running" | "idle" | "stopped" | "exited" | "failed" | (string & {});
export type UiSessionSource = "wand" | "automation" | "claude-history" | "codex-history";
export type UiSidebarGroupKind = "wand" | "automation" | "history";
export type UiManageTarget = "session" | "claude-history" | "codex-history";

export interface UiSessionVm {
  id: string;
  source: UiSessionSource;
  provider: UiProvider;
  kind: UiSessionKind;
  title: string;
  description: string;
  cwd: string;
  status: UiSessionStatus;
  statusLabel: string;
  active: boolean;
  selected: boolean;
  resumable: boolean;
  permissionBlocked: boolean;
  inFlight: boolean;
  startedAt?: string;
  endedAt?: string;
  claudeSessionId?: string;
  worktree?: Readonly<{
    enabled: boolean;
    branch?: string;
    path?: string;
    mergeStatus?: string;
  }>;
}

export interface UiSidebarGroupVm {
  kind: UiSidebarGroupKind;
  label: string;
  expanded: boolean;
  entries: readonly Readonly<UiSessionVm>[];
}

/**
 * The shell snapshot deliberately excludes high-frequency terminal output,
 * messages, composer drafts, and streaming state. Those stay in their owning
 * feature modules instead of invalidating the whole application shell.
 */
export interface UiSnapshotData {
  auth: Readonly<{
    phase: UiAuthPhase;
  }>;
  viewport: Readonly<{
    mobile: boolean;
    online: boolean;
    embedTerminal: boolean;
    nativeInput: boolean;
  }>;
  capabilities: Readonly<{
    backToNative: boolean;
    switchServer: boolean;
  }>;
  layout: Readonly<{
    sessionsDrawerOpen: boolean;
    sidebarPinned: boolean;
    sidebarCollapsed: boolean;
    sidebarAnchored: boolean;
    sessionsBackdropVisible: boolean;
    filePanelOpen: boolean;
    filePanelBackdropVisible: boolean;
    topbarMoreOpen: boolean;
    currentView: UiView;
  }>;
  selected: Readonly<UiSessionVm> | null;
  sidebar: Readonly<{
    interactiveCount: number;
    totalCount: number;
    manageMode: boolean;
    selectedCount: number;
    groups: readonly Readonly<UiSidebarGroupVm>[];
  }>;
  topbar: Readonly<{
    title: string;
    description: string;
    statusLabel: string;
    statusTone: string;
    cwd: string;
    currentTask: string;
    git: null | Readonly<{
      branch: string;
      modifiedCount: number;
      clean: boolean;
    }>;
  }>;
  legacyVisibility: Readonly<{
    terminal: boolean;
    chat: boolean;
    blank: boolean;
    composer: boolean;
  }>;
}

export type UiSnapshot = Readonly<UiSnapshotData & { revision: number }>;

export type UiAction =
  | { type: "nav.home" }
  | { type: "nav.refresh" }
  | { type: "session.new" }
  | { type: "session.quickStart.claude" }
  | { type: "session.quickStart.codex" }
  | { type: "session.quickStart.opencode" }
  | { type: "session.quickStart.structured" }
  | { type: "session.select"; id: string }
  | { type: "session.resume"; id: string }
  | { type: "session.resumeHistory"; provider: "claude" | "codex"; id: string; cwd: string }
  | { type: "session.delete"; target: UiManageTarget; id: string }
  | { type: "session.merge"; id: string }
  | { type: "session.cleanup"; id: string }
  | { type: "session.manage.toggle" }
  | { type: "session.manage.select"; target: UiManageTarget; id: string }
  | { type: "session.manage.selectAll" }
  | { type: "session.manage.clear" }
  | { type: "session.manage.deleteSelected" }
  | { type: "layout.drawer.toggle" }
  | { type: "layout.drawer.close" }
  | { type: "layout.drawer.pin" }
  | { type: "layout.drawer.collapse" }
  | { type: "layout.drawer.expandGroup"; group: "automation" | "history" }
  | { type: "layout.drawer.group.set"; group: "automation" | "history"; expanded: boolean }
  | { type: "layout.files.toggle" }
  | { type: "layout.files.close" }
  | { type: "layout.files.refresh" }
  | { type: "layout.files.navigate"; cwd: string }
  | { type: "layout.files.up" }
  | { type: "layout.files.search"; query: string }
  | { type: "layout.files.search.clear" }
  | { type: "folderPicker.open" }
  | { type: "topbar.menu.toggle" }
  | { type: "topbar.copy"; field: "providerSessionId" | "cwd" | "sessionId" }
  | { type: "topbar.gitCommit" }
  | { type: "settings.open" }
  | { type: "native.back" }
  | { type: "native.switchServer" }
  | { type: "auth.logout" };

export interface UiPublishOptions {
  /** Skip the batching window and refresh the cached snapshot immediately. */
  sync?: boolean;
  /** Diagnostic context for the legacy adapter; it does not enter the snapshot. */
  reason?: string;
}

export interface UiStore {
  /** Returns the same object identity until the next completed publish. */
  getSnapshot(): UiSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: UiAction): void | Promise<unknown>;
  /** Migration-only invalidation seam. The adapter always reads a complete snapshot. */
  publish(options?: UiPublishOptions): void;
  dispose(): void;
}

export interface LegacyUiAdapterOptions {
  readSnapshot(): UiSnapshotData;
  applyAction(action: UiAction): void | Promise<unknown>;
  subscribeLegacy(listener: (reason?: string) => void): void | (() => void);
  /** 0 uses microtask batching; 1..200 batches notifications in a timer window. */
  batchMs?: number;
  /** Defaults to true. Cloning is always enabled even when freezing is disabled. */
  freezeSnapshots?: boolean;
}

export interface MemoryUiAdapterOptions {
  batchMs?: number;
  freezeSnapshots?: boolean;
}

type Listener = () => void;
type ReadSnapshot = () => UiSnapshotData;
type ApplyAction = (action: UiAction) => void | Promise<unknown>;

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneValue(item, seen));
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = cloneValue(item, seen);
  return clone as T;
}

function freezeValue<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeValue(item, seen);
  return Object.freeze(value);
}

function isolateSnapshot(data: UiSnapshotData, revision: number, freeze: boolean): UiSnapshot {
  // Pick the contract fields explicitly so a broad legacy state object cannot
  // leak terminal output, messages, drafts, or other high-frequency state.
  const snapshot = cloneValue({
    auth: data.auth,
    viewport: data.viewport,
    capabilities: data.capabilities,
    layout: data.layout,
    selected: data.selected,
    sidebar: data.sidebar,
    topbar: data.topbar,
    legacyVisibility: data.legacyVisibility,
    revision,
  }) as UiSnapshot;
  return freeze ? freezeValue(snapshot) : snapshot;
}

function normalizeBatchMs(value: number | undefined): number {
  const batchMs = value ?? 0;
  if (!Number.isFinite(batchMs) || batchMs < 0 || batchMs > 200) {
    throw new RangeError("batchMs must be between 0 and 200 milliseconds");
  }
  return batchMs;
}

function reportListenerError(error: unknown): void {
  const reporter = (globalThis as typeof globalThis & { reportError?: (reason: unknown) => void }).reportError;
  if (typeof reporter === "function") {
    reporter(error);
    return;
  }
  console.error("[wand-ui-store] subscriber failed", error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as PromiseLike<unknown>).then === "function";
}

class UiStoreCore implements UiStore {
  private readonly readSnapshot: ReadSnapshot;
  private readonly applyAction: ApplyAction;
  private readonly batchMs: number;
  private readonly freezeSnapshots: boolean;
  private readonly listeners = new Set<Listener>();
  private snapshot: UiSnapshot;
  private disposed = false;
  private pending = false;
  private scheduleGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    readSnapshot: ReadSnapshot;
    applyAction: ApplyAction;
    batchMs?: number;
    freezeSnapshots?: boolean;
  }) {
    this.readSnapshot = options.readSnapshot;
    this.applyAction = options.applyAction;
    this.batchMs = normalizeBatchMs(options.batchMs);
    this.freezeSnapshots = options.freezeSnapshots !== false;
    this.snapshot = isolateSnapshot(this.readSnapshot(), 0, this.freezeSnapshots);
  }

  getSnapshot(): UiSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  dispatch(action: UiAction): void | Promise<unknown> {
    if (this.disposed) throw new Error("UiStore has been disposed");
    const result = this.applyAction(action);
    this.publish({ sync: true, reason: `action:${action.type}` });

    if (!isPromiseLike(result)) return;
    return Promise.resolve(result).then(
      (value) => {
        this.publish({ sync: true, reason: `action-settled:${action.type}` });
        return value;
      },
      (error) => {
        this.publish({ sync: true, reason: `action-settled:${action.type}` });
        throw error;
      },
    );
  }

  publish(options: UiPublishOptions = {}): void {
    if (this.disposed) return;
    if (options.sync) {
      this.cancelPendingPublish();
      this.flush();
      return;
    }
    if (this.pending) return;

    this.pending = true;
    const generation = ++this.scheduleGeneration;
    if (this.batchMs === 0) {
      queueMicrotask(() => this.flushScheduled(generation));
      return;
    }
    this.timer = setTimeout(() => this.flushScheduled(generation), this.batchMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingPublish();
    this.listeners.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private flushScheduled(generation: number): void {
    if (this.disposed || !this.pending || generation !== this.scheduleGeneration) return;
    this.pending = false;
    this.timer = null;
    this.flush();
  }

  private cancelPendingPublish(): void {
    this.pending = false;
    this.scheduleGeneration += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private flush(): void {
    if (this.disposed) return;
    this.snapshot = isolateSnapshot(
      this.readSnapshot(),
      this.snapshot.revision + 1,
      this.freezeSnapshots,
    );
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }
}

/** Production adapter for the existing imperative shell during migration. */
export class LegacyUiAdapter implements UiStore {
  private readonly store: UiStoreCore;
  private unsubscribeLegacy: () => void;

  constructor(options: LegacyUiAdapterOptions) {
    this.store = new UiStoreCore({
      readSnapshot: options.readSnapshot,
      applyAction: options.applyAction,
      batchMs: options.batchMs,
      freezeSnapshots: options.freezeSnapshots,
    });
    const unsubscribe = options.subscribeLegacy((reason) => this.publish({ reason }));
    this.unsubscribeLegacy = typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  getSnapshot(): UiSnapshot {
    return this.store.getSnapshot();
  }

  subscribe(listener: Listener): () => void {
    return this.store.subscribe(listener);
  }

  dispatch(action: UiAction): void | Promise<unknown> {
    return this.store.dispatch(action);
  }

  publish(options?: UiPublishOptions): void {
    this.store.publish(options);
  }

  dispose(): void {
    this.store.dispose();
    const unsubscribe = this.unsubscribeLegacy;
    this.unsubscribeLegacy = () => {};
    unsubscribe();
  }
}

/** In-memory adapter used by shell tests and isolated React development. */
export class MemoryUiAdapter implements UiStore {
  private readonly store: UiStoreCore;
  private memory: UiSnapshotData;
  private actions: UiAction[] = [];

  constructor(initialSnapshot: UiSnapshotData, options: MemoryUiAdapterOptions = {}) {
    this.memory = cloneValue(initialSnapshot);
    this.store = new UiStoreCore({
      readSnapshot: () => this.memory,
      applyAction: (action) => {
        this.actions.push(freezeValue(cloneValue(action)));
      },
      batchMs: options.batchMs,
      freezeSnapshots: options.freezeSnapshots,
    });
  }

  get actionLog(): readonly Readonly<UiAction>[] {
    return Object.freeze([...this.actions]);
  }

  getSnapshot(): UiSnapshot {
    return this.store.getSnapshot();
  }

  subscribe(listener: Listener): () => void {
    return this.store.subscribe(listener);
  }

  dispatch(action: UiAction): void {
    this.store.dispatch(action);
  }

  publish(options?: UiPublishOptions): void {
    this.store.publish(options);
  }

  setSnapshot(snapshot: UiSnapshotData, options?: UiPublishOptions): void {
    if (this.store.isDisposed()) return;
    this.memory = cloneValue(snapshot);
    this.publish(options);
  }

  clearActionLog(): void {
    this.actions = [];
  }

  dispose(): void {
    this.store.dispose();
  }
}
