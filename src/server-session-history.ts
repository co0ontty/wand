import type { Request, Response } from "express";
import type { SessionRouteContext } from "./server-session-context.js";
import { parseBoundedInteger } from "./request-limits.js";
import { messageWindowByteBudget } from "./message-truncator.js";
import { toSessionDetailDTO } from "./session-transport.js";
import { WAND_PROTOCOL_VERSION } from "./structured-client-protocol.js";

/** Same session read URLs/cursors, backed by an immutable store with no execution owner. */
export function sendSessionHistory(req: Request, res: Response, ctx: SessionRouteContext, pageOnly = false): boolean {
  const snapshot = ctx.storage.getSessionHistory(req.params.id);
  if (!snapshot) return false;
  const reader = ctx.storage.sessionHistory.messages;
  const total = reader.sessionMessageCount(snapshot.id);
  const compact = ctx.wantsCompactTools(req);
  const byteBudget = messageWindowByteBudget(req.query.byteBudget);
  const strictByteBudget = typeof req.query.byteBudget === "string";
  const hasBudget = typeof req.query.blockBudget === "string" && /^\d+$/.test(req.query.blockBudget) && Number(req.query.blockBudget) > 0;
  const blockBudget = hasBudget ? parseBoundedInteger(req.query.blockBudget, 60, 1, pageOnly ? 200 : 2_000) : undefined;
  const defaults = ctx.config.cardDefaults ?? {};
  if (pageOnly && Number.isFinite(Number.parseInt(String(req.query.turn ?? ""), 10))) {
    const turn = parseBoundedInteger(req.query.turn, 0, 0, Math.max(0, total - 1));
    const blockEnd = parseBoundedInteger(req.query.blockOffset, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
    const page = reader.readSessionMessagePage(snapshot.id, defaults, { compact, turn, blockEnd, byteBudget,
      strictByteBudget: hasBudget || strictByteBudget, blockBudget,
      rawBlockLimit: hasBudget ? undefined : parseBoundedInteger(req.query.blockLimit, 40, 1, 200) });
    res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, turnIndex: turn, blocks: page.messages[0]?.content ?? [],
      blockOffset: page.leadingBlockOffset, blockTotal: page.leadingBlockTotal, blockVisible: page.leadingVisibleCount });
    return true;
  }
  const before = pageOnly && hasBudget && typeof req.query.before === "string"
    ? parseBoundedInteger(req.query.before, total, 0, total) : undefined;
  const options = { compact, blockBudget, byteBudget, strictByteBudget, before,
    ...(pageOnly && before === undefined ? { offset: parseBoundedInteger(req.query.offset, 0, 0, total),
      turnLimit: parseBoundedInteger(req.query.limit, 40, 1, 200) } : {}) };
  const page = reader.readSessionMessagePage(snapshot.id, defaults, options);
  res.setHeader("Cache-Control", "no-store");
  if (pageOnly) res.json({ wandProtocolVersion: WAND_PROTOCOL_VERSION, ...page, offset: page.messageOffset, total });
  else res.json(toSessionDetailDTO(snapshot, { ...page, messageProjection: "projected", ...(req.query.output === "omit" ? { output: "" } : {}) }));
  return true;
}
