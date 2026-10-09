import type { StructuredExecHost } from "./structured-exec-host.js";
import type { TerminalHost } from "./terminal-host.js";
import type { DaemonMaintenanceStatus } from "./daemon-maintenance-state.js";

/** One admission barrier for PTY and structured starts, not for ongoing input/output. */
export class DaemonAdmission {
  private barrier: Promise<void> | null = null;
  private active = 0;
  private settled: (() => void) | null = null;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.barrier) await this.barrier;
    this.active++;
    try { return await operation(); }
    finally { if (--this.active === 0) this.settled?.(); }
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    while (this.barrier) await this.barrier;
    let release!: () => void;
    this.barrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      if (this.active) await new Promise<void>((resolve) => { this.settled = resolve; });
      return await operation();
    } finally {
      this.settled = null;
      this.barrier = null;
      release();
    }
  }

  terminal(host: TerminalHost): TerminalHost {
    return {
      persistent: host.persistent,
      attach: (id, seq) => host.attach(id, seq),
      createOrAttach: (request, seq) => this.run(() => host.createOrAttach(request, seq)),
      forget: (id) => host.forget(id),
      flush: () => host.flush?.(),
      disconnect: () => host.disconnect(),
    };
  }

  structured(host: StructuredExecHost): StructuredExecHost {
    return {
      persistent: host.persistent,
      spawnStructured: (request) => this.run(() => host.spawnStructured(request)),
      listRuns: () => host.listRuns(),
      attachRun: (id) => host.attachRun(id),
      adoptRun: (id) => host.adoptRun(id),
      forgetRun: (id) => host.forgetRun(id),
    };
  }
}

export interface DaemonInspection {
  /** Authenticated incarnation, never a pid-file guess or a cached UI count. */
  identity: string;
  pending: boolean;
  /** null = inventory deliberately not fetched while manager-owned work is busy. */
  running: number | null;
}

export interface DaemonMaintenanceTarget {
  name: string;
  inspect(includeInventory?: boolean): Promise<DaemonInspection>;
  /** Must recheck identity and use graceful shutdown, never a force-kill. */
  restart(expected: DaemonInspection): Promise<void>;
}

export interface DaemonMaintenanceOptions {
  targets: DaemonMaintenanceTarget[];
  admission: DaemonAdmission;
  /** Includes Core, starting runs, final checkpoints and queued input. */
  busy(): boolean;
  beginCoreDrain(): () => void;
  available(): boolean;
  log(error: unknown): void;
  now?: () => number;
  quietMs?: number;
}

/** Lifecycle-owned worker. GET only projects its state; it never performs maintenance. */
export class DaemonMaintenance {
  private state: DaemonMaintenanceStatus = { pending: false, phase: "idle" };
  private timer: NodeJS.Timeout | null = null;
  private flight: Promise<void> | null = null;
  private stopped = false;
  private idleSince: number | null = null;
  private failures = 0;

  constructor(private readonly options: DaemonMaintenanceOptions) {}

  status(): DaemonMaintenanceStatus { return { ...this.state }; }

  start(): void {
    if (this.timer || this.flight || this.stopped || !this.options.targets.length) return;
    const poll = async (): Promise<void> => {
      await this.check();
      if (this.stopped) return;
      this.timer = setTimeout(() => { this.timer = null; void poll(); },
        Math.min(300_000, 15_000 * 2 ** Math.min(this.failures, 5)));
      this.timer.unref();
    };
    void poll();
  }

  check(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.inspectAndUpdate().catch((error) => {
      this.idleSince = null;
      if (this.state.pending) this.state = { pending: true, phase: "retrying" };
      this.failures++;
      // Backoff plus rate-limited diagnostics, not a repeated user notification.
      if (this.failures === 1 || this.failures % 10 === 0) this.options.log(error);
    }).finally(() => { this.flight = null; });
    return this.flight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flight;
  }

  private async inspectAndUpdate(): Promise<void> {
    const o = this.options;
    if (!o.available()) { this.idleSince = null; return; }
    // Reading full replay inventories while a known session is busy only adds
    // load. Versions still refresh so the waiting notice remains accurate.
    const includeInventory = !o.busy();
    const inspected = await Promise.allSettled(o.targets.map((target) => target.inspect(includeInventory)));
    if (inspected.some((result) => result.status === "fulfilled" && result.value.pending)) {
      this.state = { pending: true, phase: "waiting" };
    }
    const snapshots = inspected.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const pending = snapshots.some((snapshot) => snapshot.pending);
    this.state = { pending, phase: pending ? "waiting" : "idle" };
    if (!pending) this.failures = 0;
    if (!pending || o.busy() || snapshots.some((snapshot) => snapshot.running !== 0)) {
      this.idleSince = null;
      return;
    }
    const now = (o.now ?? Date.now)();
    this.idleSince ??= now;
    if (now - this.idleSince < (o.quietMs ?? 10_000)) return;

    await o.admission.exclusive(async () => {
      if (this.stopped || !o.available()) return;
      const releaseCore = o.beginCoreDrain();
      try {
        // Close the check/start race, including unowned daemon runs and shells
        // that are idle in the UI but still have a live PTY process.
        const fresh = await Promise.all(o.targets.map((target) => target.inspect()));
        if (this.stopped || !o.available() || o.busy() || fresh.some((snapshot) => snapshot.running !== 0)) return;
        this.state = { pending: true, phase: "updating" };
        for (let i = 0; i < fresh.length; i++) {
          if (this.stopped || !o.available() || o.busy()) return;
          if (fresh[i].pending) await o.targets[i].restart(fresh[i]);
        }
        const after = await Promise.all(o.targets.map((target) => target.inspect()));
        if (after.some((snapshot) => snapshot.pending)) throw new Error("Daemon replacement is not ready yet");
        this.state = { pending: false, phase: "idle" };
        this.failures = 0;
      } finally {
        this.idleSince = null;
        releaseCore();
        if (this.state.phase === "updating") this.state = { pending: true, phase: "waiting" };
      }
    });
  }
}
