import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";

const WINDOW_MS = 30 * 60_000;
const MAX_EVENTS = 1000;
const MAX_SESSIONS = 2000;

/** Deliberately omit text, commands, paths, prompts, errors and credentials. */
function state(snapshot: SessionSnapshot | null) {
  if (!snapshot) return null;
  return {
    status: snapshot.status,
    kind: snapshot.sessionKind ?? "pty",
    inFlight: snapshot.structuredState?.inFlight === true,
    provider: snapshot.provider ?? null,
    runner: snapshot.runner ?? null,
    engine: snapshot.structuredState?.engine ?? null,
    ptyBusy: snapshot.ptyBusy === true,
    ptyCommandRunning: snapshot.ptyCommandRunning === true,
    providerCliActive: snapshot.providerCliActive ?? null,
    turnStartedAt: snapshot.structuredState?.turnStartedAt ?? snapshot.ptyTurnStartedAt ?? null,
    lastActivityAt: snapshot.structuredState?.lastActivityAt ?? snapshot.ptyLastActivityAt ?? null,
    permissionBlocked: snapshot.permissionBlocked === true,
    queued: snapshot.queuedMessages?.length ?? 0,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt ?? null,
    exitCode: snapshot.exitCode ?? null,
  };
}

/** Opt-in file export; a bounded in-memory timeline, not a raw log/database dump. */
export function registerDiagnostics(app: Express, options: {
  sessions: SessionRegistry;
  storage: WandStorage;
  version: string;
  inventory(): Promise<unknown>;
}): (event: { type: string; sessionId: string }) => void {
  const startedAt = new Date().toISOString();
  let droppedEvents = 0;
  const lastStates = new Map<string, ReturnType<typeof state>>();
  const events: { at: number; requestId: string; sessionId: string | null; sessionIds?: string[];
    sessionIdsTruncated?: boolean; failedSessionIds?: string[]; operation: string;
    phase: "request" | "response" | "disconnected" | "event"; httpStatus?: number; durationMs?: number;
    before: ReturnType<typeof state>; after?: ReturnType<typeof state> }[] = [];
  function append(event: typeof events[number]) {
    events.push(event);
    const cutoff = Date.now() - WINDOW_MS;
    while (events.length > MAX_EVENTS || (events[0]?.at ?? Infinity) < cutoff) {
      events.shift();
      droppedEvents++;
    }
  }
  app.use("/api", (req, res, next) => {
    // Fixed route grammar: never copy an arbitrary URL/query/body into a report.
    const route = /^\/(sessions|structured-sessions)\/([0-9a-f-]{36})\/(resume|stop|input)$/.exec(req.path)
      ?? /^\/(sessions)\/([0-9a-f-]{36})$/.exec(req.path);
    const batchDelete = req.path === "/sessions/batch-delete" && req.method === "POST";
    if ((!route || !["POST", "DELETE"].includes(req.method)) && !batchDelete) { next(); return; }
    const sessionId = route?.[2] ?? null;
    const operation = batchDelete ? "batch-delete" : route?.[3] === "input"
      ? ["ctrl_c", "esc"].includes(req.body?.shortcutKey) ? "interrupt" : null
      : route?.[3] ?? (req.method === "DELETE" ? "delete" : null);
    if (!operation) { next(); return; }
    const ids: string[] = batchDelete && Array.isArray(req.body?.sessionIds)
      ? req.body.sessionIds.filter((id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) : [];
    const batch = batchDelete ? { sessionIds: ids.slice(0, 100), sessionIdsTruncated: ids.length > 100 } : {};
    const at = Date.now(), requestId = randomUUID();
    const before = state(sessionId ? options.sessions.getSlim(sessionId) : null);
    append({ at, requestId, sessionId, ...batch, operation, phase: "request", before });
    let finished = false;
    let failedSessionIds: string[] | undefined;
    if (batchDelete) {
      const json = res.json.bind(res);
      res.json = body => {
        if (Array.isArray(body?.failed)) {
          failedSessionIds = body.failed.filter((id: unknown): id is string => typeof id === "string"
            && /^[0-9a-f-]{36}$/.test(id)).slice(0, 100);
        }
        return json(body);
      };
    }
    const record = (phase: "response" | "disconnected") => {
      if (finished) return;
      finished = true;
      append({ at: Date.now(), requestId, sessionId, ...batch, failedSessionIds, operation, phase,
        ...(phase === "response" ? { httpStatus: res.statusCode } : {}), durationMs: Date.now() - at,
        before, after: state(sessionId ? options.sessions.getSlim(sessionId) : null) });
    };
    res.once("finish", () => record("response"));
    res.once("close", () => record("disconnected"));
    next();
  });

  let exportsInFlight = 0;
  app.get("/api/diagnostics/export", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (exportsInFlight >= 2) {
      res.set("Retry-After", "10").status(429).json({ error: "诊断采集中，请稍后重试。" });
      return;
    }
    exportsInFlight++;
    try {
      const all = options.sessions.listSlim();
      const selected = all.slice(0, MAX_SESSIONS);
      const inventory = await options.inventory();
      const cutoff = Date.now() - WINDOW_MS;
      const report = {
        schema: 1, exportedAt: new Date().toISOString(), serverStartedAt: startedAt,
        version: options.version, node: process.version, platform: process.platform,
        windowMinutes: 30, privacy: "Metadata only; no chat, terminal output, commands, paths or credentials. No automatic upload.",
        sessionsTruncated: all.length > MAX_SESSIONS,
        sessions: selected.map(snapshot => ({ id: snapshot.id, owner: options.sessions.ownerOf(snapshot.id),
          runtime: state(options.sessions.ownerOf(snapshot.id) === "storage" ? null : snapshot),
          stored: state(options.storage.getSessionSlim(snapshot.id)) })),
        inventory, droppedEvents, events: events.filter(event => event.at >= cutoff),
      };
      res.attachment(`wand-diagnostics-${Date.now()}.json`).type("application/json").send(JSON.stringify(report, null, 2));
    } catch (error) { next(error); }
    finally { exportsInFlight--; }
  });
  return event => {
    if (!["started", "ended", "deleted", "resync", "status"].includes(event.type)) return;
    const before = lastStates.get(event.sessionId) ?? null;
    const after = state(options.sessions.getSlim(event.sessionId));
    // Heartbeats must not crowd stop/delete receipts out of the bounded ring.
    if (event.type === "status" && before && after
      && JSON.stringify({ ...before, lastActivityAt: null }) === JSON.stringify({ ...after, lastActivityAt: null })) return;
    lastStates.delete(event.sessionId);
    if (after) lastStates.set(event.sessionId, after);
    if (lastStates.size > MAX_SESSIONS) lastStates.delete(lastStates.keys().next().value!);
    append({ at: Date.now(), requestId: randomUUID(), sessionId: event.sessionId,
      operation: event.type, phase: "event", before, after });
  };
}
