import { createHash } from "node:crypto";
import type { ConversationDetail } from "./conversation-types.js";
import type { ConversationTurn } from "./types.js";

import type { ConversationSync, ConversationSyncQuery } from "./conversation-sync-contract.js";
export type { ConversationSyncQuery } from "./conversation-sync-contract.js";
type Fingerprints = { id: string; metadata: string; messages: Map<string, string> };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Anchors survive deletion of the first loaded row. Never use an array offset as a durable cursor.
function key(turn: ConversationTurn): string[] { return [turn.createdAt ?? "", turn.role === "user" ? "0" : "1", turn.messageId!]; }
function compare(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) { const d = a[i].localeCompare(b[i]); if (d) return d; }
  return 0;
}
function anchor(turn: ConversationTurn): string { return Buffer.from(JSON.stringify(key(turn))).toString("base64url"); }
function decode(value?: string): string[] | null {
  if (!value || value.length > 2048) return null;
  try { const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    return Array.isArray(parsed) && parsed.length === 3 && parsed.every(v => typeof v === "string") ? parsed : null;
  } catch { return null; }
}

/** Owner-scoped, bounded diff fingerprints only: no transcript copy or persistent client state. */
export class ConversationSynchronizer {
  private readonly revisions = new Map<string, Fingerprints>();
  constructor(private readonly read: (id: string, select: (turns: ConversationTurn[]) => ConversationTurn[]) => ConversationDetail) {}

  sync(id: string, query: ConversationSyncQuery = {}): ConversationSync {
    let from: string | null = null, hasEarlier = false, total = 0;
    const limit = Math.min(80, Math.max(1, query.limit ?? 40));
    const requestedAnchor = decode(query.from);
    const detail = this.read(id, raw => {
      const all = raw.map((turn, i) => turn.messageId ? turn : { ...turn, messageId: `${id}:legacy:${i}` })
        .sort((a, b) => compare(key(a), key(b)));
      total = all.length;
      let start = requestedAnchor ? all.findIndex(turn => compare(key(turn), requestedAnchor) >= 0) : Math.max(0, total - limit);
      if (start < 0) start = total;
      if (query.older && requestedAnchor) start = Math.max(0, start - limit);
      // Bound the first page by bytes too. One indivisible turn may exceed this soft budget.
      if (!requestedAnchor) {
        let bytes = 0;
        for (let i = total - 1; i >= start; i--) {
          const size = Buffer.byteLength(JSON.stringify(all[i]));
          if (bytes + size > 96 * 1024 && i < total - 1) { start = i + 1; break; }
          bytes += size;
        }
      }
      hasEarlier = start > 0;
      from = all[start] ? anchor(all[start]) : query.from ?? null;
      return all.slice(start);
    });
    const { messages, ...metadata } = detail;
    const metadataHash = hash(metadata);
    const fingerprints = new Map(messages.map(turn => [turn.messageId!, hash(turn)]));
    const order = [...fingerprints.keys()];
    if (order.length !== messages.length) throw new Error("对话消息身份重复，无法安全同步。");
    const revision = hash([id, metadataHash, from, hasEarlier, total, [...fingerprints]]);
    const history = { revision, from, hasEarlier, total };
    const previous = query.since ? this.revisions.get(query.since) : undefined;
    this.revisions.delete(revision);
    // Avoid a large reader retaining unbounded fingerprint maps; cache miss resets the
    // SAME anchored window, never silently drops already loaded history.
    if (order.length <= 10_000) this.revisions.set(revision, { id, metadata: metadataHash, messages: fingerprints });
    while (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!);
    if (query.since === revision) return { id, history, unchanged: true };
    const valid = previous?.id === id ? previous : undefined;
    return { id, history, reset: !valid,
      ...(valid?.metadata === metadataHash ? {} : { detail: metadata }),
      messages: valid ? messages.filter(turn => valid.messages.get(turn.messageId!) !== fingerprints.get(turn.messageId!)) : messages,
      messageOrder: order };
  }
}

