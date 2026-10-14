/** Provider kinds whose native session id is discovered by polling the provider's on-disk history. */
export type ProviderDiscoveryKind = "claude" | "codex" | "opencode";

export interface ProviderDiscoveryOptions {
  /** Delay before the first attempt. */
  firstDelayMs?: number;
  /** Base delay between attempts; doubles per attempt up to maxRetryDelayMs. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Hard cap on attempts so a provider that never writes history stops being polled. */
  maxAttempts?: number;
  /** Wall-clock budget from start(); whichever of attempts/deadline is hit first ends polling. */
  deadlineMs?: number;
  now?: () => number;
  /** Returns true when polling is finished (discovered, not applicable, or the record is stale). */
  attempt: () => boolean;
  /** Called once when the cap or deadline is hit without a discovery. */
  onExhausted?: (attempts: number) => void;
}

const DEFAULT_FIRST_DELAY_MS = 500;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 360;
const DEFAULT_DEADLINE_MS = 30 * 60_000;

/**
 * One bounded polling loop for provider session discovery. Timers are always
 * unref'd so polling never keeps the server alive, and cancel() is idempotent.
 */
export class ProviderDiscovery {
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private deadlineAt = 0;
  private finished = false;
  private readonly options: ProviderDiscoveryOptions;

  constructor(options: ProviderDiscoveryOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.timer !== null;
  }

  start(): void {
    this.cancel();
    this.finished = false;
    this.attempts = 0;
    this.deadlineAt = this.now() + (this.options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    this.schedule(this.options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS);
  }

  cancel(): void {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private schedule(delayMs: number): void {
    const timer = setTimeout(() => this.tick(), delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private tick(): void {
    this.timer = null;
    if (this.finished) return;
    this.attempts += 1;
    if (this.options.attempt()) {
      this.finished = true;
      return;
    }
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (this.attempts >= maxAttempts || this.now() >= this.deadlineAt) {
      this.finished = true;
      this.options.onExhausted?.(this.attempts);
      return;
    }
    const base = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const cap = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.schedule(Math.min(cap, base * 2 ** Math.min(this.attempts - 1, 3)));
  }
}

/**
 * Timer group owned by one session record. clearAll() is the single teardown
 * point for exit, stop, cleanup and delete paths.
 */
export class SessionTimers {
  /** Quiet-window timer for the non-Claude PTY turn tracker. */
  ptyTurn: NodeJS.Timeout | null = null;
  /** Delayed initial input delivery. */
  initialInput: NodeJS.Timeout | null = null;
  private readonly discoveries = new Map<ProviderDiscoveryKind, ProviderDiscovery>();

  /** Replaces any previous discovery of the same kind and starts the new one. */
  startDiscovery(kind: ProviderDiscoveryKind, attempt: () => boolean, onExhausted?: (attempts: number) => void): void {
    this.discoveries.get(kind)?.cancel();
    const discovery = new ProviderDiscovery({ attempt, onExhausted });
    this.discoveries.set(kind, discovery);
    discovery.start();
  }

  cancelDiscovery(kind: ProviderDiscoveryKind): void {
    this.discoveries.get(kind)?.cancel();
    this.discoveries.delete(kind);
  }

  hasDiscovery(kind: ProviderDiscoveryKind): boolean {
    return this.discoveries.get(kind)?.active === true;
  }

  clearPtyTurn(): void {
    if (this.ptyTurn) clearTimeout(this.ptyTurn);
    this.ptyTurn = null;
  }

  clearInitialInput(): void {
    if (this.initialInput) clearTimeout(this.initialInput);
    this.initialInput = null;
  }

  /** Cancels every timer in the group. Safe to call repeatedly. */
  clearAll(): void {
    this.clearPtyTurn();
    this.clearInitialInput();
    for (const discovery of this.discoveries.values()) discovery.cancel();
    this.discoveries.clear();
  }
}
