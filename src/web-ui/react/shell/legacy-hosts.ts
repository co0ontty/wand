/**
 * A React-owned slot is rendered empty. After the first mount, only the
 * injected legacy port may add or remove nodes beneath it.
 */
export interface LegacyHostSlot {
  readonly childNodes: ArrayLike<unknown>;
}

export type LegacyAwaitable<T> = T | PromiseLike<T>;

export interface LegacyHostPort<TSlot extends LegacyHostSlot> {
  mount(slot: TSlot): void;
  unmount?(slot: TSlot): void;
}

export interface LegacyHostLease<TSlot extends LegacyHostSlot> {
  readonly slot: TSlot;
  readonly generation: number;
}

/**
 * Owns the imperative lifetime of one empty React slot. A controller is sticky
 * to its first slot so React reconciliation cannot silently move legacy DOM.
 */
export class LegacyHost<TSlot extends LegacyHostSlot> {
  private readonly name: string;
  private readonly port: LegacyHostPort<TSlot>;
  private rememberedSlot: TSlot | null = null;
  private mounted = false;
  private disposed = false;
  private generation = 0;

  constructor(name: string, port: LegacyHostPort<TSlot>) {
    this.name = name;
    this.port = port;
  }

  mount(slot: TSlot): LegacyHostLease<TSlot> {
    if (this.disposed) throw new Error(`${this.name} has been disposed`);
    if (this.rememberedSlot && this.rememberedSlot !== slot) {
      throw new Error(`${this.name} cannot switch to a different slot`);
    }
    if (this.mounted) return this.currentLease();
    if (!this.rememberedSlot && slot.childNodes.length !== 0) {
      throw new Error(`${this.name} requires an empty React slot`);
    }

    this.port.mount(slot);
    this.rememberedSlot = slot;
    this.mounted = true;
    this.generation += 1;
    return this.currentLease();
  }

  unmount(slot?: TSlot): void {
    if (slot && this.rememberedSlot && slot !== this.rememberedSlot) {
      throw new Error(`${this.name} cannot unmount a different slot`);
    }
    if (!this.mounted || !this.rememberedSlot) return;

    const activeSlot = this.rememberedSlot;
    this.mounted = false;
    this.generation += 1;
    this.port.unmount?.(activeSlot);
  }

  currentLease(): LegacyHostLease<TSlot> {
    if (!this.mounted || !this.rememberedSlot || this.disposed) {
      throw new Error(`${this.name} is not mounted`);
    }
    return Object.freeze({ slot: this.rememberedSlot, generation: this.generation });
  }

  isCurrent(lease: LegacyHostLease<TSlot>): boolean {
    return !this.disposed
      && this.mounted
      && this.rememberedSlot === lease.slot
      && this.generation === lease.generation;
  }

  isMounted(): boolean {
    return !this.disposed && this.mounted;
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.unmount();
    } finally {
      this.disposed = true;
    }
  }
}

export interface LegacySyncContext {
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  isCurrent(): boolean;
}

export interface LegacySyncResult {
  readonly status: "applied" | "stale";
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
}

function syncResult(context: LegacySyncContext, status: LegacySyncResult["status"]): LegacySyncResult {
  return Object.freeze({
    status,
    sessionId: context.sessionId,
    generation: context.generation,
    epoch: context.epoch,
  });
}

function createSyncContext<TSlot extends LegacyHostSlot>(
  sessionId: string,
  lifecycle: LegacyHost<TSlot>,
  lease: LegacyHostLease<TSlot>,
  epoch: number,
  isLatestEpoch: () => boolean,
): LegacySyncContext {
  const context: LegacySyncContext = {
    sessionId,
    generation: lease.generation,
    epoch,
    isCurrent: () => lifecycle.isCurrent(lease) && isLatestEpoch(),
  };
  return Object.freeze(context);
}

export interface LegacyTerminalOutput {
  readonly id: string;
}

export interface LegacyTerminalPort<
  TSlot extends LegacyHostSlot,
  TOutput extends LegacyTerminalOutput,
  TPayload,
> {
  mount(slot: TSlot): void;
  unmount?(slot: TSlot): void;
  findOutput(slot: TSlot): TOutput | null;
  load(sessionId: string, context: LegacySyncContext): LegacyAwaitable<TPayload>;
  commit(output: TOutput, payload: TPayload, context: LegacySyncContext): void;
}

/** Keeps the original #output node while applying only the latest sync. */
export class LegacyTerminalHost<
  TSlot extends LegacyHostSlot,
  TOutput extends LegacyTerminalOutput,
  TPayload,
> {
  private readonly port: LegacyTerminalPort<TSlot, TOutput, TPayload>;
  private readonly lifecycle: LegacyHost<TSlot>;
  private stableOutput: TOutput | null = null;
  private syncEpoch = 0;

  constructor(port: LegacyTerminalPort<TSlot, TOutput, TPayload>) {
    this.port = port;
    this.lifecycle = new LegacyHost("LegacyTerminalHost", {
      mount: (slot) => {
        port.mount(slot);
        this.captureStableOutput(slot);
      },
      unmount: (slot) => port.unmount?.(slot),
    });
  }

  mount(slot: TSlot): LegacyHostLease<TSlot> {
    return this.lifecycle.mount(slot);
  }

  unmount(slot?: TSlot): void {
    this.lifecycle.unmount(slot);
  }

  get output(): TOutput | null {
    return this.stableOutput;
  }

  async sync(sessionId: string): Promise<LegacySyncResult> {
    const lease = this.lifecycle.currentLease();
    const output = this.captureStableOutput(lease.slot);
    const epoch = ++this.syncEpoch;
    const context = createSyncContext(
      sessionId,
      this.lifecycle,
      lease,
      epoch,
      () => epoch === this.syncEpoch,
    );
    const payload = await this.port.load(sessionId, context);
    if (!context.isCurrent()) return syncResult(context, "stale");

    const currentOutput = this.captureStableOutput(lease.slot);
    if (currentOutput !== output) {
      throw new Error("LegacyTerminalHost #output identity changed before commit");
    }
    this.port.commit(output, payload, context);
    this.captureStableOutput(lease.slot);
    return syncResult(context, "applied");
  }

  dispose(): void {
    this.lifecycle.dispose();
  }

  private captureStableOutput(slot: TSlot): TOutput {
    const output = this.port.findOutput(slot);
    if (!output || output.id !== "output") {
      throw new Error("LegacyTerminalHost requires the legacy #output node");
    }
    if (this.stableOutput && output !== this.stableOutput) {
      throw new Error("LegacyTerminalHost must preserve #output identity");
    }
    this.stableOutput = output;
    return output;
  }
}

export interface LegacyChatPort<TSlot extends LegacyHostSlot, TPayload> {
  mount(slot: TSlot): void;
  unmount?(slot: TSlot): void;
  load(sessionId: string, context: LegacySyncContext): LegacyAwaitable<TPayload>;
  commit(slot: TSlot, payload: TPayload, context: LegacySyncContext): void;
}

/** Latest-only async bridge for the imperative streaming chat surface. */
export class LegacyChatHost<TSlot extends LegacyHostSlot, TPayload> {
  private readonly port: LegacyChatPort<TSlot, TPayload>;
  private readonly lifecycle: LegacyHost<TSlot>;
  private syncEpoch = 0;

  constructor(port: LegacyChatPort<TSlot, TPayload>) {
    this.port = port;
    this.lifecycle = new LegacyHost("LegacyChatHost", port);
  }

  mount(slot: TSlot): LegacyHostLease<TSlot> {
    return this.lifecycle.mount(slot);
  }

  unmount(slot?: TSlot): void {
    this.lifecycle.unmount(slot);
  }

  async sync(sessionId: string): Promise<LegacySyncResult> {
    const lease = this.lifecycle.currentLease();
    const epoch = ++this.syncEpoch;
    const context = createSyncContext(
      sessionId,
      this.lifecycle,
      lease,
      epoch,
      () => epoch === this.syncEpoch,
    );
    const payload = await this.port.load(sessionId, context);
    if (!context.isCurrent()) return syncResult(context, "stale");

    this.port.commit(lease.slot, payload, context);
    return syncResult(context, "applied");
  }

  dispose(): void {
    this.lifecycle.dispose();
  }
}

export interface LegacyComposerSelection {
  readonly start: number;
  readonly end: number;
  readonly direction?: "forward" | "backward" | "none";
}

export interface LegacyComposerSessionState {
  readonly draft: string;
  readonly selection: LegacyComposerSelection | null;
}

export interface LegacyCompositionToken {
  readonly id: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly sessionEpoch: number;
}

export interface LegacyComposerEvents {
  draftChanged(sessionId: string, draft: string): boolean;
  selectionChanged(sessionId: string, selection: LegacyComposerSelection): boolean;
  compositionStarted(sessionId: string): LegacyCompositionToken | null;
  compositionEnded(
    token: LegacyCompositionToken,
    draft: string,
    selection?: LegacyComposerSelection | null,
  ): boolean;
}

export interface LegacyComposerPort<TSlot extends LegacyHostSlot, TPayload> {
  mount(slot: TSlot, events: LegacyComposerEvents): void;
  unmount?(slot: TSlot): void;
  activateSession?(slot: TSlot, sessionId: string): void;
  loadSession(sessionId: string, context: LegacySyncContext): LegacyAwaitable<TPayload>;
  applySession(slot: TSlot, payload: TPayload, context: LegacySyncContext): void;
  saveDraft(sessionId: string, draft: string): void;
  saveSelection(sessionId: string, selection: LegacyComposerSelection): void;
  setComposing(sessionId: string, composing: boolean): void;
}

/**
 * Session-scoped composer bridge. Every draft, selection, and IME completion
 * carries its originating session so a late DOM event cannot mutate the newly
 * selected session.
 */
export class LegacyComposerHost<TSlot extends LegacyHostSlot, TPayload = LegacyComposerSessionState> {
  private readonly port: LegacyComposerPort<TSlot, TPayload>;
  private readonly lifecycle: LegacyHost<TSlot>;
  private readonly events: LegacyComposerEvents;
  private currentSessionId: string | null = null;
  private sessionEpoch = 0;
  private syncEpoch = 0;
  private compositionSequence = 0;
  private activeComposition: LegacyCompositionToken | null = null;

  constructor(port: LegacyComposerPort<TSlot, TPayload>) {
    this.port = port;
    this.events = Object.freeze({
      draftChanged: (sessionId: string, draft: string) => this.acceptDraft(sessionId, draft),
      selectionChanged: (sessionId: string, selection: LegacyComposerSelection) => (
        this.acceptSelection(sessionId, selection)
      ),
      compositionStarted: (sessionId: string) => this.beginComposition(sessionId),
      compositionEnded: (
        token: LegacyCompositionToken,
        draft: string,
        selection?: LegacyComposerSelection | null,
      ) => this.endComposition(token, draft, selection),
    });
    this.lifecycle = new LegacyHost("LegacyComposerHost", {
      mount: (slot) => port.mount(slot, this.events),
      unmount: (slot) => port.unmount?.(slot),
    });
  }

  mount(slot: TSlot): LegacyHostLease<TSlot> {
    return this.lifecycle.mount(slot);
  }

  unmount(slot?: TSlot): void {
    if (slot && this.lifecycle.isMounted() && this.lifecycle.currentLease().slot !== slot) {
      throw new Error("LegacyComposerHost cannot unmount a different slot");
    }
    this.cancelComposition();
    this.currentSessionId = null;
    this.sessionEpoch += 1;
    this.syncEpoch += 1;
    this.lifecycle.unmount(slot);
  }

  async sync(sessionId: string): Promise<LegacySyncResult> {
    const lease = this.lifecycle.currentLease();
    if (sessionId !== this.currentSessionId) {
      this.cancelComposition();
      this.currentSessionId = sessionId;
      this.sessionEpoch += 1;
      this.port.activateSession?.(lease.slot, sessionId);
    }

    const requestSessionEpoch = this.sessionEpoch;
    const epoch = ++this.syncEpoch;
    const context = createSyncContext(
      sessionId,
      this.lifecycle,
      lease,
      epoch,
      () => epoch === this.syncEpoch
        && requestSessionEpoch === this.sessionEpoch
        && this.currentSessionId === sessionId,
    );
    const payload = await this.port.loadSession(sessionId, context);
    if (!context.isCurrent()) return syncResult(context, "stale");

    this.port.applySession(lease.slot, payload, context);
    return syncResult(context, "applied");
  }

  acceptDraft(sessionId: string, draft: string): boolean {
    if (!this.isActiveSession(sessionId)) return false;
    this.port.saveDraft(sessionId, draft);
    return true;
  }

  acceptSelection(sessionId: string, selection: LegacyComposerSelection): boolean {
    if (!this.isActiveSession(sessionId)) return false;
    this.port.saveSelection(sessionId, copySelection(selection));
    return true;
  }

  beginComposition(sessionId: string): LegacyCompositionToken | null {
    if (!this.isActiveSession(sessionId)) return null;
    this.cancelComposition();
    const lease = this.lifecycle.currentLease();
    const token = Object.freeze({
      id: ++this.compositionSequence,
      sessionId,
      generation: lease.generation,
      sessionEpoch: this.sessionEpoch,
    });
    this.port.setComposing(sessionId, true);
    this.activeComposition = token;
    return token;
  }

  endComposition(
    token: LegacyCompositionToken,
    draft: string,
    selection: LegacyComposerSelection | null = null,
  ): boolean {
    if (!this.isCurrentComposition(token)) return false;
    this.activeComposition = null;
    this.port.setComposing(token.sessionId, false);
    this.port.saveDraft(token.sessionId, draft);
    if (selection) this.port.saveSelection(token.sessionId, copySelection(selection));
    return true;
  }

  dispose(): void {
    if (this.lifecycle.isMounted()) this.unmount();
    this.lifecycle.dispose();
  }

  private isActiveSession(sessionId: string): boolean {
    return this.lifecycle.isMounted() && this.currentSessionId === sessionId;
  }

  private isCurrentComposition(token: LegacyCompositionToken): boolean {
    if (!this.activeComposition || this.activeComposition.id !== token.id) return false;
    if (!this.isActiveSession(token.sessionId)) return false;
    const lease = this.lifecycle.currentLease();
    return token.generation === lease.generation
      && token.sessionEpoch === this.sessionEpoch;
  }

  private cancelComposition(): void {
    const active = this.activeComposition;
    if (!active) return;
    this.activeComposition = null;
    this.port.setComposing(active.sessionId, false);
  }
}

function copySelection(selection: LegacyComposerSelection): LegacyComposerSelection {
  return Object.freeze({
    start: selection.start,
    end: selection.end,
    ...(selection.direction ? { direction: selection.direction } : {}),
  });
}
