import type { SessionSnapshot } from "./types.js";

/** Exactly the Codable fields in iOS SessionActivityAttributes.ContentState; dates use Apple's reference epoch. */
export interface LiveActivityEntry {
  id: string;
  serverID: string;
  title: string;
  providerRaw: string;
  stateRaw: "responding" | "background" | "permission" | "waiting-input" | "failed" | "stopped" | "done";
  taskTitle?: string;
  queuedCount: number;
  startedAt?: number;
  finishedAt?: number;
  engineRaw?: string;
  pendingPrompt?: string;
}
export interface LiveActivityCachedEntry extends LiveActivityEntry { finishedUntil?: number }
export interface LiveActivityContent { sessions: LiveActivityEntry[]; updatedAt: number }
export const APPLE_REFERENCE_UNIX_SECONDS = 978_307_200;
export const LIVE_ACTIVITY_HEARTBEAT_MS = 60_000;
export const LIVE_ACTIVITY_STALE_SECONDS = 180;
const priorities: Record<LiveActivityEntry["stateRaw"], number> = {
  permission: 0, "waiting-input": 1, failed: 2, responding: 3, background: 4, stopped: 5, done: 6,
};
const providers = new Set(["claude", "codex", "opencode", "grok", "qoder", "pi"]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function liveActivityText(value: string, maxCharacters: number, maxBytes: number): string {
  let text = "", bytes = 0, count = 0;
  for (const { segment } of segmenter.segment(value.trim())) {
    if (++count > maxCharacters || bytes + Buffer.byteLength(segment) > maxBytes) break;
    text += segment; bytes += Buffer.byteLength(segment);
  }
  return text;
}
function appleDate(value: string | undefined | null): number | undefined {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms / 1000 - APPLE_REFERENCE_UNIX_SECONDS : undefined;
}
function responding(session: SessionSnapshot): boolean {
  if (session.sessionKind === "structured") return session.structuredState?.inFlight === true;
  if (session.status !== "running" || session.providerCliActive === false) return false;
  return providers.has(session.provider ?? "") ? session.ptyBusy === true : session.ptyCommandRunning === true;
}
function entry(session: SessionSnapshot, serverID: string, stateRaw: LiveActivityEntry["stateRaw"]): LiveActivityCachedEntry {
  const busy = stateRaw === "responding" || stateRaw === "background";
  const title = liveActivityText(session.title || "会话", 24, 96);
  return {
    id: session.id, serverID, title,
    providerRaw: liveActivityText(session.provider ?? "terminal", 40, 60), stateRaw,
    taskTitle: session.currentTaskTitle ? liveActivityText(session.currentTaskTitle, 40, 120) : undefined,
    queuedCount: Math.max(0, Math.min(9999, session.queuedMessages?.length ?? 0)),
    startedAt: busy ? appleDate(session.structuredState?.turnStartedAt ?? session.ptyTurnStartedAt) : undefined,
    engineRaw: session.structuredState?.engine,
    // Do not put escalation arguments, targets, paths, transcript, command or cwd on Apple's servers.
    pendingPrompt: stateRaw === "permission" ? "等待你的授权后继续" : stateRaw === "waiting-input" ? "等待你的回复后继续" : undefined,
  };
}
export function liveActivityWireEntry(cached: LiveActivityCachedEntry): LiveActivityEntry {
  const { finishedUntil: _finishedUntil, ...wire } = cached;
  return wire;
}

/** A pure snapshot projection: no execution changes, fabricated progress, historical-completion replay or timer extension. */
export function projectLiveActivity(
  sessions: readonly SessionSnapshot[], previous: readonly LiveActivityCachedEntry[], serverID: string, now: number,
): { entries: LiveActivityCachedEntry[]; content: LiveActivityContent; event: "update" | "end"; signature: string; urgent: boolean; nextAt: number } {
  const oldById = new Map(previous.filter(item => item.serverID === serverID).map(item => [item.id, item]));
  const entries: LiveActivityCachedEntry[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const old = oldById.get(session.id);
    const pending = !!session.pendingEscalation || session.permissionBlocked === true;
    if (pending) { entries.push(entry(session, serverID, "permission")); continue; }
    if (responding(session)) {
      entries.push(entry(session, serverID, session.structuredState?.phase === "background" ? "background" : "responding"));
      continue;
    }
    // A terminal snapshot only earns a grace period if this activity actually observed it working.
    if (!old) continue;
    let state: LiveActivityEntry["stateRaw"] | undefined;
    if (session.status === "failed" || (session.status === "exited" && session.exitCode !== 0)) state = "failed";
    else if (session.status === "stopped") state = "stopped";
    else if (["responding", "background", "done"].includes(old.stateRaw)) state = "done";
    if (!state) continue;
    const finishedUntil = old.stateRaw === state && old.finishedUntil !== undefined
      ? old.finishedUntil : now + (state === "failed" ? 30_000 : 12_000);
    if (finishedUntil <= now) continue;
    const finished = entry(session, serverID, state);
    finished.finishedAt = (finishedUntil - (state === "failed" ? 30_000 : 12_000)) / 1000 - APPLE_REFERENCE_UNIX_SECONDS;
    finished.queuedCount = 0; delete finished.taskTitle; delete finished.startedAt;
    entries.push({ ...finished, finishedUntil });
  }
  entries.sort((a, b) => priorities[a.stateRaw] - priorities[b.stateRaw] || a.id.localeCompare(b.id));
  entries.splice(8);
  const updatedAt = now / 1000 - APPLE_REFERENCE_UNIX_SECONDS;
  // Reserve ample room for APNs envelope/timestamp/stale-date. Never split a composed Unicode character.
  while (entries.length > 1 && Buffer.byteLength(JSON.stringify({ sessions: entries.map(liveActivityWireEntry), updatedAt })) > 3300) entries.pop();
  const event = entries.length ? "update" : "end";
  const wire = entries.length ? entries.map(liveActivityWireEntry) : previous.map(liveActivityWireEntry);
  const content = { sessions: wire.slice(0, 8), updatedAt };
  const signature = JSON.stringify([event, entries.map(liveActivityWireEntry)]);
  const nextAt = Math.min(now + LIVE_ACTIVITY_HEARTBEAT_MS, ...entries.flatMap(item => item.finishedUntil === undefined ? [] : [item.finishedUntil]));
  return { entries, content, event, signature,
    urgent: event === "end" || entries.some(item => ["permission", "waiting-input", "failed", "done", "stopped"].includes(item.stateRaw)), nextAt };
}

export function liveActivityPayload(content: LiveActivityContent, event: "update" | "end", timestamp: number): string {
  const payload = JSON.stringify({ aps: { timestamp, event, "content-state": content,
    ...(event === "end" ? { "dismissal-date": 0 } : { "stale-date": timestamp + LIVE_ACTIVITY_STALE_SECONDS }) } });
  if (Buffer.byteLength(payload) > 4096) throw new Error("Live Activity payload exceeds APNs budget");
  return payload;
}
