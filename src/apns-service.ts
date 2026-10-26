import type { ApnsConfiguration, ApnsResult, ApnsTransport } from "./apns-client.js";
import { apnsDigest } from "./storage/apns-repository.js";
import type { WandStorage } from "./storage.js";
import type { ProcessEvent, SessionSnapshot } from "./types.js";

export class ApnsService {
  private stopped = false;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastSweep = 0;
  private nextWarningAt = 0;
  private report(message: string): void {
    if (this.now() < this.nextWarningAt) return;
    this.nextWarningAt = this.now() + 60_000;
    this.warn(message);
  }
  constructor(
    private readonly storage: WandStorage,
    readonly configuration: ApnsConfiguration | null,
    private readonly transport: ApnsTransport | null,
    private readonly credentialDigest: () => string,
    private readonly getSession: (id: string) => SessionSnapshot | null,
    private readonly warn: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    storage.onClose(() => this.dispose());
  }
  get available(): boolean { return !!this.configuration && !!this.transport && !this.stopped; }

  start(): void {
    if (!this.available || this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, 2000);
    this.timer.unref();
    void this.flush(); // includes persisted, still-actionable outbox entries after a restart.
  }

  /** Called only by SessionCompletionTracker when it creates a NEW successful completion fact. */
  completed(sessionId: string, revision: number): void {
    if (!this.available) return;
    try {
      const session = this.getSession(sessionId);
      if (!session || session.archived) return;
      this.enqueue(sessionId, "completed", String(revision));
    } catch { this.report("APNs 无法读取会话提醒事实；不影响执行。"); }
  }
  ingest(event: ProcessEvent): void {
    if (!this.available || (event.type !== "status" && event.type !== "ended")) return;
    try {
      const session = this.getSession(event.sessionId);
      if (!session || session.archived) return;
      // The durable request ID is the fact. Never hash permission contents/tool arguments into a payload.
      const requestId = session.pendingEscalation?.requestId;
      if (requestId) this.enqueue(session.id, "permission", requestId);
    } catch { this.report("APNs 无法读取会话提醒事实；不影响执行。"); }
  }
  private enqueue(sessionId: string, kind: "completed" | "permission", revision: string): void {
    try {
      const config = this.configuration!;
      const capacityAvailable = this.storage.apns.enqueue(sessionId, kind, revision, this.credentialDigest(), config.topic, config.environment, this.now());
      if (!capacityAvailable) this.report("APNs 提醒队列已满，部分提醒可能被丢弃；执行与历史不受影响。");
      void this.flush();
    } catch { this.report("APNs 提醒未能入队；执行与历史不受影响。"); }
  }

  /** A single bounded consumer, independent from the lifetime of PTY/Render/Core. */
  flush(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (!this.running) {
      this.running = this.drain().catch(() => {
        if (!this.stopped) this.report("APNs 队列暂不可用，将稍后重试。");
      }).finally(() => { this.running = null; });
    }
    return this.running;
  }
  private async drain(): Promise<void> {
    if (this.now() - this.lastSweep >= 60_000) {
      this.storage.apns.sweep(this.now());
      this.lastSweep = this.now();
    }
    // Bound work per pump even under an event burst. Pending work remains in SQLite.
    for (let i = 0; i < 32 && !this.stopped; i++) {
      const job = this.storage.apns.due(this.now());
      if (!job) return;
      const device = this.storage.apns.device(job.device_id);
      const session = this.getSession(job.session_id);
      const stale = !device || !device.enabled || device.generation !== job.generation
        || device.expires_at <= this.now() || device.credential_digest !== this.credentialDigest()
        || device.topic !== this.configuration!.topic || device.environment !== this.configuration!.environment
        || job.expires_at <= this.now() || !session || session.archived
        || (job.kind === "permission" && session.pendingEscalation?.requestId !== job.revision)
        || (job.kind === "completed" && ((session.viewedCompletionRevision ?? 0) >= Number(job.revision)
          || (session.completionRevision ?? 0) !== Number(job.revision) || !!session.pendingEscalation
          || session.ptyBusy === true || session.structuredState?.inFlight === true));
      if (stale) { this.storage.apns.finish(job.id, "canceled", "NoLongerActionable"); continue; }
      const payload = JSON.stringify({
        aps: { alert: {
          title: job.kind === "permission" ? "需要你的授权" : "回复已完成",
          body: job.kind === "permission" ? "Wand 会话正在等待确认，点击查看。" : "Wand 会话已有新结果，点击查看。",
        }, sound: "default", "thread-id": apnsDigest(`${device!.server_id}:${job.session_id}`).slice(0, 32) },
        eventId: job.event_id, sessionId: job.session_id, serverId: device!.server_id, kind: job.kind,
      });
      let result: ApnsResult;
      try {
        result = await this.transport!.send({ id: job.id, token: device!.token, payload,
          expiresAt: job.expires_at, collapseId: job.event_id });
      } catch { result = { outcome: "retry", reason: "TransportFailure" }; }
      if (this.stopped) return; // storage may have closed while the HTTP/2 request was in flight.
      if (result.outcome === "accepted") this.storage.apns.finish(job.id, "accepted", result.reason);
      else if (result.outcome === "invalid-device") {
        this.storage.apns.finish(job.id, "failed", result.reason);
        this.storage.apns.invalidateDevice(job.device_id, job.generation);
      } else if (result.outcome === "retry" && job.attempts < 4) {
        this.storage.apns.retry(job.id, job.attempts + 1, this.now() + Math.min(60_000, 2000 * 2 ** job.attempts), result.reason);
      } else {
        this.storage.apns.finish(job.id, "failed", result.reason);
        this.report(`APNs 未接受提醒（${result.reason}），不影响会话执行。`);
      }
    }
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.transport?.close();
  }
}
