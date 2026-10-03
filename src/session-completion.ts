import type { WandStorage } from "./storage.js";
import type { ProcessEvent, SessionSnapshot } from "./types.js";

/** Observe completion facts without combining PTY and structured execution implementations. */
export class SessionCompletionTracker {
  private readonly busyPty = new Set<string>();
  private readonly completedPty = new Set<string>();
  private readonly ended = new Map<string, string>();

  constructor(
    private readonly storage: WandStorage,
    private readonly getSession: (id: string) => SessionSnapshot | null,
  ) {}

  ingest(event: ProcessEvent): void {
    if (event.type === "started") {
      this.busyPty.delete(event.sessionId);
      this.completedPty.delete(event.sessionId);
      this.ended.delete(event.sessionId);
      return;
    }
    if (event.type !== "status" && event.type !== "ended") return;
    const data = event.data as Record<string, unknown> | undefined;
    if (!data) return;
    const snapshot = this.getSession(event.sessionId);
    if (!snapshot) return;
    let completed = false;
    if ((snapshot.sessionKind ?? "pty") === "structured") {
      if (event.type === "ended" && snapshot.status === "idle" && snapshot.exitCode === 0
        && !snapshot.structuredState?.inFlight && !snapshot.structuredState?.lastError) {
        const key = snapshot.endedAt ?? "";
        completed = !!key && this.ended.get(snapshot.id) !== key;
        if (completed) this.ended.set(snapshot.id, key);
      }
    } else {
      if (data.ptyBusy === true) {
        this.busyPty.add(snapshot.id);
        this.completedPty.delete(snapshot.id);
      } else if (data.ptyBusy === false && this.busyPty.delete(snapshot.id)) {
        completed = !snapshot.permissionBlocked && !snapshot.pendingEscalation
          && snapshot.status === "running"
          && !(typeof snapshot.providerCliExitCode === "number" && snapshot.providerCliExitCode !== 0);
      }
      if ((data.providerCliActive === false && data.providerCliExitCode === 0)
        || (event.type === "ended" && snapshot.status === "exited" && snapshot.exitCode === 0)) {
        completed ||= !this.completedPty.has(snapshot.id);
      }
      if (completed) this.completedPty.add(snapshot.id);
      if (event.type === "ended") this.busyPty.delete(snapshot.id);
    }
    if (completed) {
      const completion = this.storage.recordSessionCompletion(snapshot.id);
      if (completion) Object.assign(data, completion);
    }
  }
}
