import type { ApnsConfiguration, ApnsResult, ApnsTransport } from "./apns-client.js";
import { LIVE_ACTIVITY_HEARTBEAT_MS, liveActivityPayload, projectLiveActivity, type LiveActivityCachedEntry } from "./live-activity-state.js";
import type { WandStorage } from "./storage.js";
import type { ProcessEvent, SessionSnapshot } from "./types.js";

function newAttentionState(previousSignature: string, projection: ReturnType<typeof projectLiveActivity>): boolean {
  if (!projection.urgent) return false;
  if (projection.event === "end") return true;
  const attention = new Set(["permission", "waiting-input", "failed", "stopped", "done"]);
  let previous: LiveActivityCachedEntry[] = [];
  try {
    const parsed = JSON.parse(previousSignature);
    if (Array.isArray(parsed) && Array.isArray(parsed[1])) previous = parsed[1];
  } catch { /* first update */ }
  const key = (entry: LiveActivityCachedEntry): string => JSON.stringify([entry.id, entry.stateRaw, entry.finishedAt]);
  const known = new Set(previous.filter(entry => attention.has(entry.stateRaw)).map(key));
  return projection.entries.some(entry => attention.has(entry.stateRaw) && !known.has(key(entry)));
}

/** Updates already-created ActivityKit activities only. Never starts an activity or changes execution facts. */
export class LiveActivityService {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastSweep = 0;
  private nextWarningAt = 0;
  constructor(
    private readonly storage: WandStorage,
    readonly configuration: ApnsConfiguration | null,
    private readonly transport: ApnsTransport | null,
    private readonly credentialDigest: () => string,
    private readonly getSessions: () => readonly SessionSnapshot[] | null,
    private readonly warn: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) { storage.onClose(() => this.dispose()); }
  get available(): boolean { return !!this.configuration && !!this.transport && !this.stopped; }
  private report(message: string): void {
    if (this.now() < this.nextWarningAt) return;
    this.nextWarningAt = this.now() + 60_000;
    this.warn(message);
  }
  start(): void {
    if (!this.available || this.timer) return;
    this.storage.liveActivities.wake(this.now());
    this.timer = setInterval(() => { void this.flush(); }, 2000);
    this.timer.unref();
    void this.flush();
  }
  ingest(event: ProcessEvent): void {
    if (!this.available || !["started", "status", "task", "ended"].includes(event.type)) return;
    try { this.storage.liveActivities.dirty(this.now()); }
    catch { this.report("灵动岛状态暂不可入队；不影响任务执行。"); }
  }
  flush(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (!this.running) {
      this.running = this.drain().catch(() => {
        if (!this.stopped) this.report("灵动岛远程更新暂不可用，将稍后重试。");
      }).finally(() => { this.running = null; });
    }
    return this.running;
  }
  private async drain(): Promise<void> {
    if (this.now() - this.lastSweep >= 60_000) {
      this.storage.liveActivities.sweep(this.now()); this.lastSweep = this.now();
    }
    for (let i = 0; i < 12 && !this.stopped; i++) {
      let record = this.storage.liveActivities.due(this.now());
      if (!record) return;
      if (record.expires_at <= this.now() || record.credential_digest !== this.credentialDigest()
        || record.topic !== this.configuration!.topic || record.environment !== this.configuration!.environment) {
        this.storage.liveActivities.disable(record.id, "ExpiredOrCredentialChanged", record.generation); continue;
      }
      const snapshots = this.getSessions();
      // A failed/unfinished session recovery is not evidence that every running session has completed or disappeared.
      if (!snapshots) { this.storage.liveActivities.defer(record.id, record.generation, this.now() + 30_000); continue; }
      const previous = JSON.parse(record.content_json) as LiveActivityCachedEntry[];
      const projection = projectLiveActivity(snapshots, previous, record.server_id, this.now());
      // Foreground optimistic Activity.request may beat the server's input-acceptance event.
      if (!projection.entries.length && !record.signature && !previous.length && this.now() - record.created_at < 30_000) {
        this.storage.liveActivities.defer(record.id, record.generation, Math.min(record.created_at + 30_000, this.now() + 2000)); continue;
      }
      if (!record.pending_payload || record.pending_signature !== projection.signature) {
        if (record.signature === projection.signature && this.now() - record.last_sent_at < LIVE_ACTIVITY_HEARTBEAT_MS) {
          this.storage.liveActivities.defer(record.id, record.generation, Math.min(projection.nextAt, record.last_sent_at + LIVE_ACTIVITY_HEARTBEAT_MS)); continue;
        }
        const timestamp = Math.floor(this.now() / 1000);
        // ActivityKit orders by seconds. Never send equal/older timestamps or invent a future progress timestamp.
        if (timestamp <= record.last_timestamp) {
          this.storage.liveActivities.defer(record.id, record.generation, (record.last_timestamp + 1) * 1000); continue;
        }
        const prepared = this.storage.liveActivities.prepare(record, {
          payload: liveActivityPayload(projection.content, projection.event, timestamp),
          signature: projection.signature, entries: projection.entries, event: projection.event,
          priority: newAttentionState(record.signature, projection) ? 10 : 5, timestamp, nextAt: projection.nextAt,
        }, this.now());
        if (!prepared) continue;
        record = prepared;
      }
      let result: ApnsResult;
      try {
        result = await this.transport!.send({ id: record.pending_id!, token: record.token,
          payload: record.pending_payload!, collapseId: record.id,
          expiresAt: Math.min(record.expires_at, (record.last_timestamp + 180) * 1000),
          pushType: "liveactivity", priority: record.pending_priority ?? 5 });
      } catch { result = { outcome: "retry", reason: "TransportFailure" }; }
      if (this.stopped) return;
      if (result.outcome === "invalid-device") {
        this.storage.liveActivities.disable(record.id, result.reason, record.generation);
      } else if (result.outcome === "retry" && record.attempts < 4) {
        this.storage.liveActivities.retry(record, result.reason, this.now());
      } else {
        this.storage.liveActivities.finish(record, result.outcome === "accepted" ? "accepted" : result.outcome === "rejected" ? "rejected" : "failed", result.reason, this.now());
        if (result.outcome !== "accepted") this.report(`APNs 未接受灵动岛更新（${result.reason}）；不影响普通消息推送与任务执行。`);
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
