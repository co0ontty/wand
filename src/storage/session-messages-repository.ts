import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WandStorage } from "../storage.js";
import type { CardExpandDefaults, ContentBlock, ConversationTurn } from "../types.js";
import { enrichStructuredMessages } from "../structured-client-protocol.js";
import { alignedBlockStart, blockWindowMessagesForTransport, compactToolMessagesForTransport, measureTransportBlocks, truncateMessagesForTransport, visibleBlockCount, windowMessagesForTransport, type BlockWindowedMessages } from "../message-truncator.js";

export interface MessagePageOptions {
  compact?: boolean;
  blockBudget?: number;
  byteBudget?: number;
  strictByteBudget?: boolean;
  before?: number;
  turn?: number;
  blockEnd?: number;
  rawBlockLimit?: number;
  turnLimit?: number;
  offset?: number;
}

interface TurnRow {
  turn_index: number;
  metadata_json: string;
  outline_json: string;
  block_count: number;
}

/** Raw execution history and the formatted read model have independent storage shapes. */
export class SessionMessageRepository {
  private readonly settledTurnDigests = new WeakMap<ConversationTurn, string>();
  constructor(private readonly db: DatabaseSync, private readonly storage: WandStorage) {}

  hasSessionMessageRows(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM session_message_heads WHERE session_id = ? AND format_version = 1").get(id);
  }

  /** Import legacy history once. The original column remains intact for rollback. */
  ensureSessionMessageRows(id: string): void {
    if (this.hasSessionMessageRows(id)) return;
    const row = this.db.prepare("SELECT messages FROM command_sessions WHERE id = ?").get(id) as { messages: string | null } | undefined;
    if (!row) return;
    let messages: ConversationTurn[] = [];
    if (row.messages) {
      try { const parsed: unknown = JSON.parse(row.messages); if (Array.isArray(parsed)) messages = parsed; }
      catch { /* Preserve malformed legacy data verbatim; match the old safe parser. */ }
    }
    this.writeSessionMessageRows(id, messages);
  }

  loadSessionMessageRows(id: string): ConversationTurn[] {
    return this.readSessionRawMessageRange(id, 0, Number.MAX_SAFE_INTEGER);
  }

  /** Compare individual turns; never stringify or rewrite the entire conversation blob. */
  writeSessionMessageRows(id: string, messages: ConversationTurn[], immutablePrefix = false): void {
    if (!this.db.prepare("SELECT 1 FROM command_sessions WHERE id = ?").get(id)) return;
    this.prepareSessionMessageWrite(id, messages, immutablePrefix)();
  }

  /** Prepare outside the write lock; callers commit payload and runtime cursor together. */
  prepareSessionMessageWrite(id: string, messages: ConversationTurn[], immutablePrefix = false): () => void {
    const previous = this.db.prepare("SELECT turn_index, digest FROM session_message_turns WHERE session_id = ? ORDER BY turn_index").all(id) as Array<{ turn_index: number; digest: string }>;
    let liveStart = messages.length - 1;
    while (liveStart > 0 && !(messages[liveStart].role === "user" && messages[liveStart].content.some(block => block.type === "text"))) liveStart--;
    const digests = messages.map((turn, index) => {
      const settled = immutablePrefix && index < liveStart;
      const cached = settled ? this.settledTurnDigests.get(turn) : undefined;
      if (cached) return cached;
      const raw = JSON.stringify(turn);
      const digest = createHash("sha256").update(raw).digest("hex");
      if (settled) this.settledTurnDigests.set(turn, digest);
      return digest;
    });
    if (!this.hasSessionMessageRows(id)) previous.length = 0;
    const changed = digests.findIndex((digest, index) => previous[index]?.digest !== digest);
    if (changed < 0 && previous.length === messages.length && this.hasSessionMessageRows(id)) return () => {};

    // A user prompt starts a semantic segment (Todo/task summaries). Tool IDs
    // can link segments, so include both ends when a delayed result changes.
    const segmentByTurn: number[] = [];
    let segment = 0;
    messages.forEach((turn, index) => {
      if (index > 0 && turn.role === "user" && turn.content.some(block => block.type === "text")) segment++;
      segmentByTurn[index] = segment;
    });
    const affected = new Set<number>();
    digests.forEach((digest, index) => {
      if (previous[index]?.digest !== digest) affected.add(segmentByTurn[index]);
    });
    if (previous.length > messages.length && messages.length) affected.add(segmentByTurn[messages.length - 1]);
    const toolSegments = new Map<string, Set<number>>();
    messages.forEach((turn, index) => turn.content.forEach(block => {
      const toolId = block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : null;
      if (!toolId) return;
      const segments = toolSegments.get(toolId) ?? new Set<number>();
      segments.add(segmentByTurn[index]);
      toolSegments.set(toolId, segments);
    }));
    // Removed/replaced calls can invalidate a projection in another segment too.
    const oldTools = this.db.prepare("SELECT DISTINCT tool_id FROM session_message_blocks WHERE session_id = ? AND turn_index = ? AND tool_id IS NOT NULL");
    const changedIndices = digests.flatMap((digest, index) => previous[index]?.digest !== digest ? [index] : []);
    for (let index = messages.length; index < previous.length; index++) changedIndices.push(index);
    for (const index of changedIndices) {
      for (const row of oldTools.all(id, index) as Array<{ tool_id: string }>) {
        for (const linked of toolSegments.get(row.tool_id) ?? []) affected.add(linked);
      }
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const segments of toolSegments.values()) {
        if (![...segments].some(value => affected.has(value))) continue;
        for (const value of segments) if (!affected.has(value)) { affected.add(value); expanded = true; }
      }
    }
    const indices = messages.flatMap((_turn, index) => affected.has(segmentByTurn[index]) ? [index] : []);
    const formatted = enrichStructuredMessages(indices.map(index => messages[index]), id);
    const compact = compactToolMessagesForTransport(formatted);
    const putTurn = this.db.prepare(`INSERT INTO session_message_turns
      (session_id, turn_index, raw_json, digest, metadata_json, outline_json, block_count)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, turn_index) DO UPDATE SET
      raw_json = excluded.raw_json, digest = excluded.digest, metadata_json = excluded.metadata_json,
      outline_json = excluded.outline_json, block_count = excluded.block_count
      WHERE digest != excluded.digest OR metadata_json != excluded.metadata_json OR outline_json != excluded.outline_json`);
    const putBlock = this.db.prepare(`INSERT INTO session_message_blocks
      (session_id, turn_index, block_index, formatted_json, compact_json, tool_id, block_type, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, turn_index, block_index) DO UPDATE SET
      formatted_json = excluded.formatted_json, compact_json = excluded.compact_json,
      tool_id = excluded.tool_id, block_type = excluded.block_type, raw_json = excluded.raw_json
      WHERE formatted_json != excluded.formatted_json OR compact_json != excluded.compact_json
        OR raw_json IS NOT excluded.raw_json`);
    // Encoding also happens before BEGIN IMMEDIATE; SQLite only sees bounded row writes.
    const prepared = indices.map((index, position) => {
      const { content, ...metadata } = formatted[position];
      const fullMeasures = measureTransportBlocks(content);
      const compactMeasures = measureTransportBlocks(compact[position].content);
      const outline = content.map(block => block.type === "tool_use"
        ? { type: block.type, id: block.id, name: block.name, input: {}, semantic: block.semantic?.kind === "decision" ? { kind: "decision" } : undefined }
        : block.type === "tool_result"
          ? { type: block.type, tool_use_id: block.tool_use_id, content: "", semantic: block.semantic?.kind === "decision" ? { kind: "decision" } : undefined }
          : block.type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
      return { index, raw: JSON.stringify({ ...messages[index], content: [] }), metadata: JSON.stringify(metadata),
        outline: JSON.stringify(outline.map((block, blockIndex) => ({ block, full: fullMeasures[blockIndex], compact: compactMeasures[blockIndex] }))), blocks: content.map((block, blockIndex) =>
          [JSON.stringify(block), JSON.stringify(compact[position].content[blockIndex]),
            block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : null,
            block.type, JSON.stringify(messages[index].content[blockIndex])] as const) };
    });
    return () => this.storage.transaction(() => {
      for (const row of prepared) {
        putTurn.run(id, row.index, row.raw, digests[row.index], row.metadata, row.outline, row.blocks.length);
        row.blocks.forEach(([full, small, toolId, type, raw], blockIndex) => putBlock.run(id, row.index, blockIndex, full, small, toolId, type, raw));
        this.db.prepare("DELETE FROM session_message_blocks WHERE session_id = ? AND turn_index = ? AND block_index >= ?").run(id, row.index, row.blocks.length);
      }
      this.db.prepare("DELETE FROM session_message_blocks WHERE session_id = ? AND turn_index >= ?").run(id, messages.length);
      this.db.prepare("DELETE FROM session_message_turns WHERE session_id = ? AND turn_index >= ?").run(id, messages.length);
      this.db.prepare(`INSERT INTO session_message_heads VALUES (?, ?, 1)
        ON CONFLICT(session_id) DO UPDATE SET turn_count = excluded.turn_count, format_version = 1`).run(id, messages.length);
    });
  }

  sessionMessageCount(id: string): number {
    this.ensureSessionMessageRows(id);
    return Number(this.db.prepare("SELECT turn_count FROM session_message_heads WHERE session_id = ?").get(id)?.turn_count ?? 0);
  }

  readSessionRawMessageRange(id: string, start: number, end: number): ConversationTurn[] {
    this.ensureSessionMessageRows(id);
    const turns = this.db.prepare(`SELECT turn_index, raw_json FROM session_message_turns
      WHERE session_id = ? AND turn_index >= ? AND turn_index < ? ORDER BY turn_index`).all(id, start, end) as Array<{ turn_index: number; raw_json: string }>;
    const blocks = this.db.prepare(`SELECT turn_index, raw_json FROM session_message_blocks
      WHERE session_id = ? AND turn_index >= ? AND turn_index < ? ORDER BY turn_index, block_index`).all(id, start, end) as Array<{ turn_index: number; raw_json: string }>;
    const contentByTurn = new Map<number, ContentBlock[]>();
    for (const block of blocks) {
      const content = contentByTurn.get(block.turn_index) ?? [];
      content.push(JSON.parse(block.raw_json) as ContentBlock);
      contentByTurn.set(block.turn_index, content);
    }
    return turns.map(row => {
      const turn = JSON.parse(row.raw_json) as ConversationTurn;
      turn.content = contentByTurn.get(row.turn_index) ?? [];
      return turn;
    });
  }

  readSessionToolBlocks(id: string, toolId: string): ConversationTurn[] {
    this.ensureSessionMessageRows(id);
    const rows = this.db.prepare(`SELECT raw_json FROM session_message_blocks
      WHERE session_id = ? AND tool_id = ? ORDER BY turn_index, block_index`).all(id, toolId) as Array<{ raw_json: string }>;
    return [{ role: "assistant", content: rows.map(row => JSON.parse(row.raw_json) as ContentBlock) }];
  }

  /** Plan with stored sizes/types, then retrieve only the selected indexed block range. */
  readSessionMessagePage(id: string, defaults: CardExpandDefaults, options: MessagePageOptions = {}): BlockWindowedMessages {
    this.ensureSessionMessageRows(id);
    const head = this.db.prepare("SELECT turn_count FROM session_message_heads WHERE session_id = ?").get(id) as { turn_count: number } | undefined;
    const total = head?.turn_count ?? 0;
    const turn = options.turn !== undefined ? Math.min(Math.max(0, options.turn), Math.max(0, total - 1)) : undefined;
    const end = Math.min(total, turn !== undefined ? turn + 1 : options.before ?? total);
    let firstTurn = turn ?? Math.min(end, options.offset ?? Math.max(0, end - (options.blockBudget ? 16 : options.turnLimit ?? 40)));
    const lastTurn = options.offset !== undefined ? Math.min(end, firstTurn + (options.turnLimit ?? 40)) : end;
    let outlines: ConversationTurn[] = [];
    let rows: TurnRow[] = [];
    let plan: BlockWindowedMessages;
    const measures = new Map<ContentBlock, readonly [number, number]>();
    for (;;) {
      rows = this.db.prepare(`SELECT turn_index, metadata_json, outline_json, block_count FROM session_message_turns
        WHERE session_id = ? AND turn_index >= ? AND turn_index < ? ORDER BY turn_index`).all(id, firstTurn, lastTurn) as unknown as TurnRow[];
      outlines = rows.map(row => {
        const outline = JSON.parse(row.outline_json) as Array<{ block: ContentBlock; full: readonly [number, number]; compact: readonly [number, number] }>;
        const limit = turn !== undefined ? Math.min(row.block_count, options.blockEnd ?? row.block_count) : row.block_count;
        const content = outline.slice(0, limit).map(item => {
          measures.set(item.block, options.compact ? item.compact : item.full);
          return item.block;
        });
        return { ...JSON.parse(row.metadata_json), content } as ConversationTurn;
      });
      if (options.rawBlockLimit !== undefined) {
        const content = outlines[0]?.content ?? [];
        const start = alignedBlockStart(content, defaults, Math.max(0, content.length - options.rawBlockLimit), content.length,
          Math.min(128 * 1024, options.byteBudget ?? 1024 * 1024), measures);
        plan = { messages: outlines.length ? [{ ...outlines[0], content: content.slice(start) }] : [],
          messageOffset: 0, messageTotal: outlines.length, leadingBlockOffset: start,
          leadingBlockTotal: rows[0]?.block_count ?? 0, leadingVisibleCount: visibleBlockCount(content, defaults, start) };
      } else if (options.blockBudget) {
        plan = blockWindowMessagesForTransport(outlines, defaults, options.blockBudget, options.byteBudget, options.strictByteBudget, measures);
      } else {
        plan = { ...windowMessagesForTransport(outlines, defaults, options.turnLimit ?? 40), leadingBlockOffset: 0,
          leadingBlockTotal: rows[0]?.block_count ?? 0, leadingVisibleCount: 0 };
      }
      if (turn !== undefined || !options.blockBudget || firstTurn === 0 || plan.messageOffset > 0 || plan.leadingBlockOffset > 0) break;
      // This suffix fits entirely. Include earlier lightweight outlines until a
      // real cut is found, without loading their tool inputs/results or text.
      firstTurn = Math.max(0, firstTurn - 16);
      measures.clear();
    }
    const startTurn = firstTurn + plan.messageOffset;
    const column = options.compact ? "compact_json" : "formatted_json";
    const blockEnd = turn !== undefined ? Math.min(rows[0]?.block_count ?? 0, options.blockEnd ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const blocks = this.db.prepare(`SELECT turn_index, ${column} AS payload FROM session_message_blocks
      WHERE session_id = ? AND turn_index >= ? AND turn_index < ?
        AND (turn_index > ? OR block_index >= ?) AND (turn_index < ? OR block_index < ?)
      ORDER BY turn_index, block_index`).all(id, startTurn, lastTurn, startTurn, plan.leadingBlockOffset, lastTurn - 1, blockEnd) as Array<{ turn_index: number; payload: string }>;
    const contentByTurn = new Map<number, ContentBlock[]>();
    for (const block of blocks) {
      const content = contentByTurn.get(block.turn_index) ?? [];
      content.push(JSON.parse(block.payload) as ContentBlock);
      contentByTurn.set(block.turn_index, content);
    }
    const messages = rows.slice(plan.messageOffset).map(row => ({ ...JSON.parse(row.metadata_json), content: contentByTurn.get(row.turn_index) ?? [] }) as ConversationTurn);
    return { ...plan, messages: truncateMessagesForTransport(messages, defaults),
      messageOffset: startTurn, messageTotal: total,
      ...(turn !== undefined ? { leadingBlockTotal: rows[0]?.block_count ?? 0 } : {}) };
  }
}
