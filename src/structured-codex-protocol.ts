import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getErrorMessage } from "./error-utils.js";
import { normalizeStructuredToolResultContent } from "./structured-content.js";
import type { ContentBlock, ConversationTurn, SessionSnapshot, ToolUseBlock } from "./types.js";
import type { StructuredRunnerTurnState } from "./structured-runner.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (asRecord(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function codexPatchToolName(kind: string): string {
  if (kind === "add") return "Write";
  return "Edit";
}

function codexPatchResultText(stdout: unknown, stderr: unknown, success: boolean): string {
  const err = getString(stderr).trim();
  const out = getString(stdout).trim();
  if (!success) return err || out || "patch apply failed";
  return "";
}

export function buildCodexPatchApplyBlocks(item: Record<string, unknown>): ContentBlock[] {
  const changes = asRecord(item.changes);
  if (!changes) return [];
  const callId = getString(item.call_id) || getString(item.id) || "patch";
  const status = getString(item.status) || "completed";
  const success = item.success !== false && status !== "failed";
  const resultText = codexPatchResultText(item.stdout, item.stderr, success);
  const entries = Object.entries(changes);
  const blocks: ContentBlock[] = [];

  entries.forEach(([filePath, rawChange], index) => {
    const change = asRecord(rawChange) ?? {};
    const kind = getString(change.type) || "update";
    const unifiedDiff = getString(change.unified_diff);
    const movePath = getString(change.move_path);
    const toolUseId = `${callId}#${index}`;
    const input: Record<string, unknown> = {
      file_path: filePath,
      kind,
      status,
    };
    if (unifiedDiff) input.unified_diff = unifiedDiff;
    if (movePath) input.move_path = movePath;

    blocks.push({
      type: "tool_use",
      id: toolUseId,
      name: codexPatchToolName(kind),
      description: kind,
      input,
    });
    blocks.push({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: resultText,
      is_error: !success,
    });
  });

  return blocks;
}

const CODEX_FILE_SNAPSHOT_MAX_BYTES = 512 * 1024;
const CODEX_DIFF_MAX_EDIT_DISTANCE = 512;
const CODEX_DIFF_MAX_CHARS = 32 * 1024;
const CODEX_DIFF_CONTEXT_LINES = 3;

export interface CodexFileSnapshot {
  exists: boolean;
  text: string | null;
  unavailableReason?: string;
}

type CodexFileSnapshotMap = Map<string, CodexFileSnapshot>;

type CodexDiffLine = {
  kind: "equal" | "delete" | "add";
  text: string;
};

function readCodexFileSnapshot(filePath: string): CodexFileSnapshot {
  if (!filePath || !existsSync(filePath)) return { exists: false, text: "" };
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { exists: true, text: null, unavailableReason: "目标不是普通文件" };
    }
    if (stat.size > CODEX_FILE_SNAPSHOT_MAX_BYTES) {
      return { exists: true, text: null, unavailableReason: "文件过大，未生成差异正文" };
    }
    const content = readFileSync(filePath);
    if (content.includes(0)) {
      return { exists: true, text: null, unavailableReason: "二进制文件不支持文本差异" };
    }
    return { exists: true, text: content.toString("utf8") };
  } catch (error) {
    return {
      exists: true,
      text: null,
      unavailableReason: `读取文件失败：${getErrorMessage(error)}`,
    };
  }
}

/**
 * Myers line diff. File snapshots are bounded above; the edit-distance guard
 * keeps completely rewritten generated files from consuming quadratic memory.
 */
function diffCodexLines(before: string[], after: string[]): CodexDiffLine[] {
  const max = before.length + after.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let completedDistance = -1;

  for (let distance = 0; distance <= max && distance <= CODEX_DIFF_MAX_EDIT_DISTANCE; distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex = diagonal === -distance || (diagonal !== distance && right < down)
        ? Math.max(0, down)
        : Math.max(0, right + 1);
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < before.length
        && newIndex < after.length
        && before[oldIndex] === after[newIndex]
      ) {
        oldIndex++;
        newIndex++;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex >= before.length && newIndex >= after.length) {
        completedDistance = distance;
        break;
      }
    }
    if (completedDistance >= 0) break;
  }

  // A very large rewrite is still useful to inspect. This fallback is not
  // minimal, but remains truthful and is later clipped by transport/UI limits.
  if (completedDistance < 0) {
    return [
      ...before.map((text): CodexDiffLine => ({ kind: "delete", text })),
      ...after.map((text): CodexDiffLine => ({ kind: "add", text })),
    ];
  }

  const reversed: CodexDiffLine[] = [];
  let oldIndex = before.length;
  let newIndex = after.length;
  for (let distance = completedDistance; distance >= 0; distance--) {
    const previous = trace[distance];
    const diagonal = oldIndex - newIndex;
    const down = previous.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = previous.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -distance || (diagonal !== distance && right < down)
      ? diagonal + 1
      : diagonal - 1;
    const previousOldIndex = Math.max(0, previous.get(previousDiagonal) ?? 0);
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      reversed.push({ kind: "equal", text: before[oldIndex - 1] });
      oldIndex--;
      newIndex--;
    }
    if (distance === 0) break;
    if (oldIndex === previousOldIndex) {
      reversed.push({ kind: "add", text: after[newIndex - 1] });
      newIndex--;
    } else {
      reversed.push({ kind: "delete", text: before[oldIndex - 1] });
      oldIndex--;
    }
  }
  return reversed.reverse();
}

function codexDiffPath(filePath: string): string {
  return filePath.replace(/[\r\n]/g, " ").replace(/^\/+/, "");
}

function codexDiffLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function buildCodexUnifiedDiff(
  filePath: string,
  before: CodexFileSnapshot,
  after: CodexFileSnapshot,
): string {
  if (before.text === null || after.text === null || before.text === after.text) return "";
  const oldLines = codexDiffLines(before.text);
  const newLines = codexDiffLines(after.text);
  const lines = diffCodexLines(oldLines, newLines);
  const changedIndexes = lines
    .map((line, index) => line.kind === "equal" ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return "";

  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldCount = 0;
  let newCount = 0;
  lines.forEach((line, index) => {
    oldBefore[index] = oldCount;
    newBefore[index] = newCount;
    if (line.kind !== "add") oldCount++;
    if (line.kind !== "delete") newCount++;
  });

  const hunks: Array<{ start: number; end: number }> = [];
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - CODEX_DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, changedIndex + CODEX_DIFF_CONTEXT_LINES + 1);
    const previous = hunks[hunks.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else hunks.push({ start, end });
  }

  const displayPath = codexDiffPath(filePath);
  const output = [
    before.exists ? `--- a/${displayPath}` : "--- /dev/null",
    after.exists ? `+++ b/${displayPath}` : "+++ /dev/null",
  ];
  for (const hunk of hunks) {
    const hunkLines = lines.slice(hunk.start, hunk.end);
    const hunkOldCount = hunkLines.filter((line) => line.kind !== "add").length;
    const hunkNewCount = hunkLines.filter((line) => line.kind !== "delete").length;
    const hunkOldStart = hunkOldCount === 0 ? oldBefore[hunk.start] : oldBefore[hunk.start] + 1;
    const hunkNewStart = hunkNewCount === 0 ? newBefore[hunk.start] : newBefore[hunk.start] + 1;
    output.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`);
    for (const line of hunkLines) {
      output.push(`${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`);
    }
  }
  const diff = output.join("\n");
  if (diff.length <= CODEX_DIFF_MAX_CHARS) return diff;
  const cutAt = diff.lastIndexOf("\n", CODEX_DIFF_MAX_CHARS);
  return `${diff.slice(0, cutAt > 0 ? cutAt : CODEX_DIFF_MAX_CHARS)}\n…（差异正文已截断）`;
}

export function buildCodexFileChangeBlocks(
  item: Record<string, unknown>,
  completed: boolean,
  beforeSnapshots: CodexFileSnapshotMap = new Map(),
  afterSnapshots: CodexFileSnapshotMap = new Map(),
): ContentBlock[] {
  const id = getString(item.id) || "file-change";
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const status = getString(item.status) || (completed ? "completed" : "in_progress");
  const isError = status === "failed";
  const blocks: ContentBlock[] = [];

  rawChanges.forEach((entry, index) => {
    const change = asRecord(entry);
    if (!change) return;
    const filePath = getString(change.path);
    const kind = getString(change.kind) || "update";
    const toolUseId = `${id}#${index}`;
    const input: Record<string, unknown> = { file_path: filePath, kind, status };
    const before = beforeSnapshots.get(toolUseId);
    const after = afterSnapshots.get(toolUseId);
    if (completed && before && after) {
      const unifiedDiff = buildCodexUnifiedDiff(filePath, before, after);
      if (unifiedDiff) input.unified_diff = unifiedDiff;
      const unavailableReason = before.unavailableReason || after.unavailableReason;
      if (!unifiedDiff && unavailableReason) input.diff_unavailable_reason = unavailableReason;
    }

    blocks.push({
      type: "tool_use",
      id: toolUseId,
      name: codexPatchToolName(kind),
      description: kind,
      input,
    });
    if (completed) {
      blocks.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        content: isError ? `file change failed: ${filePath}` : "",
        is_error: isError,
      });
    }
  });
  return blocks;
}

/**
 * Codex `exec --json` only publishes authoritative usage with `turn.completed`.
 * Keep the bottom usage row useful while the turn is running by estimating the
 * model-produced text/tool arguments; the final provider value replaces this.
 */
export function estimateCodexOutputTokens(blocks: ContentBlock[]): number {
  let asciiUnits = 0;
  let wideUnits = 0;
  const addText = (value: string): void => {
    for (const char of value) {
      if (char.codePointAt(0)! <= 0x7f) asciiUnits += 1;
      else wideUnits += 1;
    }
  };
  for (const block of blocks) {
    if (block.type === "text") addText(block.text);
    else if (block.type === "thinking") addText(block.thinking);
    else if (block.type === "tool_use") {
      addText(block.name);
      try { addText(JSON.stringify(block.input)); } catch { /* best-effort live estimate */ }
    }
  }
  if (asciiUnits === 0 && wideUnits === 0) return 0;
  return Math.max(1, Math.ceil(asciiUnits / 4 + wideUnits));
}

function refreshEstimatedCodexUsage(turnState: CodexTurnState): void {
  if (turnState.usage?.estimated !== true) return;
  turnState.usage = {
    outputTokens: estimateCodexOutputTokens(turnState.blocks),
    estimated: true,
  };
}

interface CodexTurnState extends StructuredRunnerTurnState {
  codexBlockIndex: Map<string, number>;
  codexFileSnapshots: CodexFileSnapshotMap;
  cwd: string;
}

export class CodexProtocolReducer {
  readonly state: CodexTurnState;
  readonly errors: string[] = [];
  primaryError: string | null = null;

  constructor(session: SessionSnapshot) {
    this.state = {
      blocks: [],
      result: "",
      sessionId: session.claudeSessionId,
      model: session.selectedModel ?? session.structuredState?.model,
      usage: { outputTokens: 0, estimated: true },
      codexBlockIndex: new Map(),
      codexFileSnapshots: new Map(),
      cwd: session.cwd,
    };
  }

  apply(parsed: unknown): boolean {
    const event = this.unwrapCodexStreamEvent(parsed);
    if (event?.type === "thread.started" && typeof event.thread_id === "string") {
      this.state.sessionId = event.thread_id;
      return true;
    }
    if (event?.type === "item.started" && asRecord(event.item)) {
      this.applyCodexItem(this.state, event.item as Record<string, unknown>, "started");
      return this.refreshUsage();
    }
    if (event?.type === "item.updated" && asRecord(event.item)) {
      this.applyCodexItem(this.state, event.item as Record<string, unknown>, "updated");
      return this.refreshUsage();
    }
    if (event?.type === "item.completed" && asRecord(event.item)) {
      this.applyCodexItem(this.state, event.item as Record<string, unknown>, "completed");
      return this.refreshUsage();
    }
    if (event?.type === "turn.completed") {
      this.state.usage = this.extractCodexUsage(asRecord(event.usage) ?? undefined) ?? this.state.usage;
      return true;
    }
    if (event?.type === "token_count") {
      const info = asRecord(event.info);
      const lastUsage = asRecord(info?.last_token_usage);
      this.state.usage = this.extractCodexUsage(lastUsage ?? undefined) ?? this.state.usage;
      return true;
    }
    if (this.applyCodexLooseEvent(this.state, event)) return this.refreshUsage();
    if (event?.type === "error") {
      const message = typeof event.message === "string" ? event.message : "";
      if (message) this.errors.push(message);
      return false;
    }
    if (event?.type === "turn.failed") {
      const error = asRecord(event.error);
      this.primaryError = getString(error?.message) || getString(event.message) || "codex turn failed";
    }
    return false;
  }

  private refreshUsage(): true {
    refreshEstimatedCodexUsage(this.state);
    return true;
  }

  private normalizeToolResultContent(content: unknown): string | Array<{ type: string; [key: string]: unknown }> {
    return normalizeStructuredToolResultContent(content);
  }

  private unwrapCodexStreamEvent(parsed: unknown): Record<string, unknown> | null {
    const event = asRecord(parsed);
    if (!event) return null;
    const type = getString(event.type);
    if ((type === "response_item" || type === "event_msg") && asRecord(event.payload)) {
      return event.payload as Record<string, unknown>;
    }
    return event;
  }

  private applyCodexLooseEvent(turnState: CodexTurnState, event: Record<string, unknown> | null): boolean {
    if (!event) return false;
    const type = getString(event.type);
    const supported = new Set([
      "message",
      "agent_message",
      "reasoning",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "command_execution",
      "patch_apply_end",
      "file_change",
      "mcp_tool_call",
      "mcp_tool_call_end",
      "web_search_call",
      "web_search_end",
      "web_search",
      "tool_search_call",
      "tool_search_output",
      "collab_tool_call",
      "todo_list",
    ]);
    if (!supported.has(type)) return false;
    this.applyCodexItem(turnState, event, "completed");
    return true;
  }

  private codexFunctionToolUse(item: Record<string, unknown>): ToolUseBlock | null {
    const rawName = getString(item.name) || "function_call";
    const callId = getString(item.call_id) || getString(item.id) || rawName;
    const args = parseJsonRecord(item.arguments);
    const input = { ...args };

    if (rawName === "exec_command") {
      const command = getString(args.cmd) || getString(args.command);
      if (command) input.command = command;
      return {
        type: "tool_use",
        id: callId,
        name: "Bash",
        description: getString(args.workdir) || undefined,
        input,
      };
    }

    if (rawName === "write_stdin") {
      return {
        type: "tool_use",
        id: callId,
        name: "Bash",
        description: "write stdin",
        input: {
          ...input,
          command: `write_stdin ${getString(args.session_id) || getString(args.sessionId) || ""}`.trim(),
        },
      };
    }

    if (rawName === "update_plan" && Array.isArray(args.plan)) {
      const todos = args.plan.map((entry) => {
        const rec = asRecord(entry) ?? {};
        const status = getString(rec.status);
        return {
          content: getString(rec.step),
          activeForm: getString(rec.step),
          status: status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending",
        };
      });
      return {
        type: "tool_use",
        id: callId,
        name: "TodoWrite",
        description: getString(args.explanation) || undefined,
        input: { todos },
      };
    }

    if (rawName === "view_image") {
      const filePath = getString(args.path);
      return {
        type: "tool_use",
        id: callId,
        name: "Read",
        description: "view image",
        input: filePath ? { ...input, file_path: filePath } : input,
      };
    }

    if (rawName === "js") {
      return {
        type: "tool_use",
        id: callId,
        name: "node_repl__js",
        description: getString(args.title) || undefined,
        input,
      };
    }

    return {
      type: "tool_use",
      id: callId,
      name: rawName,
      input,
    };
  }

  private codexMcpToolBlocks(item: Record<string, unknown>): ContentBlock[] {
    const callId = getString(item.call_id) || getString(item.id) || "mcp";
    const invocation = asRecord(item.invocation) ?? {};
    const server = getString(invocation.server) || "mcp";
    const tool = getString(invocation.tool) || "tool";
    const args = asRecord(invocation.arguments) ?? {};
    const result = asRecord(item.result);
    const isError = !!result?.Err || getString(item.status) === "failed";
    const ok = asRecord(result?.Ok);
    const content = ok ? this.extractCodexText(ok.content) || JSON.stringify(ok).slice(0, 4096) : this.extractCodexText(result);
    return [
      { type: "tool_use", id: callId, name: `${server}__${tool}`, input: args },
      { type: "tool_result", tool_use_id: callId, content, is_error: isError },
    ];
  }

  private extractCodexText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      return value.map((item) => this.extractCodexText(item)).filter(Boolean).join("");
    }

    const record = value as Record<string, unknown>;
    for (const key of ["text", "output_text", "message", "content", "summary"]) {
      const extracted = this.extractCodexText(record[key]);
      if (extracted) return extracted;
    }
    return "";
  }

  /**
   * Merge one codex `item.*` event into `turnState.blocks`.
   *
   * 三种 phase 行为：
   *   - "started":   首次出现的 item，块直接 push（tool_result 走 upsert 配对）。
   *                  text/thinking/TodoWrite 这种"靠 id 替换"的块记录到
   *                  codexBlockIndex 里，方便后续 updated/completed 找回原位。
   *   - "updated":   codex 重发完整 ThreadItem（不是 delta）。已记录过的块就
   *                  替换；新块按 started 路径处理。
   *   - "completed": 把"in_progress"卡片定型——text 同时更新 turnState.result
   *                  以便 result fallback 不为空；tool_use ↔ tool_result 通过
   *                  共享 id 配对到一起（包括 file_change 子项的 `${id}#i`）。
   */
  private applyCodexItem(
    turnState: CodexTurnState,
    item: Record<string, unknown>,
    phase: "started" | "updated" | "completed",
  ): void {
    const completed = phase === "completed";
    const itemId = typeof item.id === "string" ? item.id : "";
    const itemType = getString(item.type);
    let afterSnapshots: CodexFileSnapshotMap | undefined;
    if (itemType === "file_change" && itemId) {
      const snapshots = turnState.codexFileSnapshots ??= new Map();
      const rawChanges = Array.isArray(item.changes) ? item.changes : [];
      if (phase === "started") {
        rawChanges.forEach((entry, index) => {
          const filePath = getString(asRecord(entry)?.path);
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(turnState.cwd || process.cwd(), filePath);
          snapshots.set(`${itemId}#${index}`, readCodexFileSnapshot(absolutePath));
        });
      } else if (completed) {
        afterSnapshots = new Map();
        rawChanges.forEach((entry, index) => {
          const filePath = getString(asRecord(entry)?.path);
          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(turnState.cwd || process.cwd(), filePath);
          afterSnapshots?.set(`${itemId}#${index}`, readCodexFileSnapshot(absolutePath));
        });
      }
    }
    const blocks = this.extractCodexItemBlock(
      item,
      completed,
      turnState.codexFileSnapshots,
      afterSnapshots,
    );
    if (blocks.length === 0) return;

    const index = turnState.codexBlockIndex ??= new Map<string, number>();

    for (const block of blocks) {
      // text / thinking / TodoWrite tool_use 的卡片是"按 item id 整体替换"语义，
      // 否则一个 agent_message 在 updated/completed 时会被重复 push 多次。
      const replaceable =
        block.type === "text"
        || block.type === "thinking"
        || (block.type === "tool_use" && block.name === "TodoWrite");

      if (replaceable && itemId) {
        const existing = index.get(itemId);
        if (existing !== undefined && existing < turnState.blocks.length) {
          turnState.blocks[existing] = block;
        } else {
          index.set(itemId, turnState.blocks.length);
          turnState.blocks.push(block);
        }
        if (block.type === "text" && completed) {
          turnState.result = block.text;
        }
        continue;
      }

      // 其它块（tool_use 非 Todo / tool_result / 文件改动的多 sub-id 块）
      // 仍然走原有 upsert：tool_result 按 tool_use_id 配对，其余直接 push。
      this.upsertCodexBlock(turnState.blocks, block);
    }
    if (completed && itemType === "file_change") {
      for (const key of [...(turnState.codexFileSnapshots?.keys() ?? [])]) {
        if (key.startsWith(`${itemId}#`)) turnState.codexFileSnapshots?.delete(key);
      }
    }
  }

  /**
   * Map a codex `item.{started,updated,completed}` payload into wand's
   * `ContentBlock[]` so the chat UI's existing tool/diff/todo cards just work.
   *
   * Codex `exec --json` emits 8 item.type values (see
   * `codex-rs/exec/src/exec_events.rs`); below they're routed to whatever wand
   * tool name reuses an existing renderer:
   *
   *   agent_message     → text
   *   reasoning         → thinking
   *   command_execution → tool_use "Bash" + tool_result
   *   file_change       → one Edit/Write per file; snapshots taken between
   *                       item.started/completed restore the omitted diff body
   *   mcp_tool_call     → tool_use named "<server>__<tool>" + tool_result
   *   web_search        → tool_use "WebSearch" + tool_result (results not in stream)
   *   todo_list         → tool_use "TodoWrite" (replaced in place on each update)
   *   error             → text block prefixed with ❌
   *
   * Returns [] when there is nothing to emit yet (e.g. agent_message at
   * `item.started` before any text has been produced).
   *
   * Callers handle in-place replacement for `item.updated` via
   * `turnState.codexBlockIndex`; tool_use ↔ tool_result pairing still goes
   * through `upsertCodexBlock` by matching ids.
   */
  private extractCodexItemBlock(
    item: Record<string, unknown>,
    completed: boolean,
    beforeSnapshots?: CodexFileSnapshotMap,
    afterSnapshots?: CodexFileSnapshotMap,
  ): ContentBlock[] {
    const id = typeof item.id === "string" ? item.id : randomUUID();
    const type = typeof item.type === "string" ? item.type : "unknown";

    if (type === "message") {
      const role = getString(item.role);
      if (role !== "assistant") return [];
      const text = this.extractCodexText(item.content);
      return text ? [{ type: "text", text }] : [];
    }

    if (type === "agent_message") {
      const text = this.extractCodexText(item);
      return text ? [{ type: "text", text }] : [];
    }

    if (type === "reasoning") {
      const text = this.extractCodexText(item);
      return text ? [{ type: "thinking", thinking: text }] : [];
    }

    if (type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "";
      const aggregatedOutput = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      const input: Record<string, unknown> = { command, status };
      if (exitCode !== null) input.exit_code = exitCode;
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: "Bash",
          description: "running",
          input,
        }];
      }
      // codex 的 status 可能是 declined（sandbox 拒了命令）/ failed（执行失败）—
      // 这时 exit_code 经常是 null，光靠 exitCode !== 0 判 is_error 会漏。
      const isError = status === "failed" || status === "declined"
        || (typeof exitCode === "number" && exitCode !== 0);
      const fallbackText = status === "declined"
        ? "command declined by sandbox"
        : (exitCode === null ? "" : `exit_code: ${exitCode}`);
      return [
        {
          type: "tool_use",
          id,
          name: "Bash",
          description: exitCode === null ? status : `${status} · exit ${exitCode}`,
          input,
        },
        {
          type: "tool_result",
          tool_use_id: id,
          content: aggregatedOutput || fallbackText,
          is_error: isError,
        },
      ];
    }

    if (type === "function_call") {
      const block = this.codexFunctionToolUse(item);
      return block ? [block] : [];
    }

    if (type === "function_call_output") {
      const callId = getString(item.call_id) || id;
      return [{
        type: "tool_result",
        tool_use_id: callId,
        content: this.normalizeToolResultContent(item.output),
      }];
    }

    if (type === "custom_tool_call") {
      const callId = getString(item.call_id) || id;
      const name = getString(item.name) || "custom_tool_call";
      return [{
        type: "tool_use",
        id: callId,
        name,
        description: getString(item.status) || undefined,
        input: {
          input: getString(item.input),
          status: getString(item.status) || (completed ? "completed" : "in_progress"),
        },
      }];
    }

    if (type === "custom_tool_call_output") {
      const callId = getString(item.call_id) || id;
      return [{
        type: "tool_result",
        tool_use_id: callId,
        content: this.normalizeToolResultContent(item.output),
      }];
    }

    if (type === "patch_apply_end") {
      return buildCodexPatchApplyBlocks(item);
    }

    if (type === "file_change") {
      return buildCodexFileChangeBlocks(item, completed, beforeSnapshots, afterSnapshots);
    }

    if (type === "mcp_tool_call_end") {
      return this.codexMcpToolBlocks(item);
    }

    if (type === "mcp_tool_call") {
      const server = typeof item.server === "string" ? item.server : "mcp";
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      const args = item.arguments && typeof item.arguments === "object" ? item.arguments as Record<string, unknown> : {};
      const errObj = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : null;
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      const isError = !!errObj || status === "failed";
      const input = { ...args, status };
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: `${server}__${tool}`,
          description: status,
          input,
        }];
      }
      let resultText = "";
      if (errObj && typeof errObj.message === "string") {
        resultText = errObj.message;
      } else if (item.result && typeof item.result === "object") {
        const resultRec = item.result as Record<string, unknown>;
        const inner = this.extractCodexText(resultRec.content);
        resultText = inner || JSON.stringify(resultRec).slice(0, 4096);
      }
      return [
        {
          type: "tool_use",
          id,
          name: `${server}__${tool}`,
          description: status,
          input,
        },
        {
          type: "tool_result",
          tool_use_id: id,
          content: resultText,
          is_error: isError,
        },
      ];
    }

    if (type === "web_search_call") {
      const callId = getString(item.call_id) || id;
      return [{
        type: "tool_use",
        id: callId,
        name: "WebSearch",
        description: getString(item.status) || "searching",
        input: {},
      }];
    }

    if (type === "web_search_end") {
      const callId = getString(item.call_id) || id;
      const action = asRecord(item.action);
      const query = getString(item.query);
      const actionType = getString(action?.type);
      return [
        {
          type: "tool_use",
          id: callId,
          name: "WebSearch",
          description: actionType || "completed",
          input: query ? { query, action: actionType } : { action: actionType },
        },
        {
          type: "tool_result",
          tool_use_id: callId,
          content: query ? `query: ${query}` : "",
        },
      ];
    }

    if (type === "tool_search_call") {
      const callId = getString(item.call_id) || id;
      const args = asRecord(item.arguments) ?? {};
      return [{
        type: "tool_use",
        id: callId,
        name: "tool_search",
        description: getString(item.status) || undefined,
        input: args,
      }];
    }

    if (type === "tool_search_output") {
      const callId = getString(item.call_id) || id;
      return [{
        type: "tool_result",
        tool_use_id: callId,
        content: this.normalizeToolResultContent(item.tools),
      }];
    }

    if (type === "web_search") {
      const query = typeof item.query === "string" ? item.query : "";
      const action = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : null;
      const actionType = action && typeof action.type === "string" ? action.type : "";
      const queries = action && Array.isArray(action.queries)
        ? action.queries.filter((v): v is string => typeof v === "string")
        : [];
      const input: Record<string, unknown> = { query };
      if (actionType) input.action = actionType;
      if (queries.length > 0) input.queries = queries;
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: "WebSearch",
          description: actionType || "searching",
          input,
        }];
      }
      return [
        {
          type: "tool_use",
          id,
          name: "WebSearch",
          description: actionType || "completed",
          input,
        },
        {
          type: "tool_result",
          tool_use_id: id,
          // codex 不在 exec 流里回 search 结果，这里给个占位让 UI 卡片完成态。
          content: queries.length > 0 ? queries.map((q) => `query: ${q}`).join("\n") : (query ? `query: ${query}` : ""),
        },
      ];
    }

    if (type === "collab_tool_call") {
      // codex 的子-agent 编排（spawn_agent / send_input / wait / close_agent）。
      // 没有对应 Claude tool，所以名称用 "Codex/<op>" 让 UI 默认 tool 卡渲染时
      // 一眼能看出来是 codex 多 agent 操作。
      const tool = typeof item.tool === "string" ? item.tool : "collab";
      const prompt = typeof item.prompt === "string" ? item.prompt : "";
      const senderId = typeof item.sender_thread_id === "string" ? item.sender_thread_id : "";
      const receiverIds = Array.isArray(item.receiver_thread_ids)
        ? (item.receiver_thread_ids.filter((v) => typeof v === "string") as string[])
        : [];
      const agentsStates = item.agents_states && typeof item.agents_states === "object"
        ? item.agents_states as Record<string, unknown>
        : {};
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      const toolName = `Codex/${tool}`;
      const input: Record<string, unknown> = { tool };
      if (prompt) input.prompt = prompt;
      if (senderId) input.sender_thread_id = senderId;
      if (receiverIds.length > 0) input.receiver_thread_ids = receiverIds;
      if (Object.keys(agentsStates).length > 0) input.agents_states = agentsStates;
      if (!completed) {
        return [{ type: "tool_use", id, name: toolName, input }];
      }
      // 完成态：把每个 receiver agent 的最终状态汇总成可读 result。
      const summaryLines: string[] = [];
      for (const [tid, state] of Object.entries(agentsStates)) {
        if (!state || typeof state !== "object") continue;
        const rec = state as Record<string, unknown>;
        const s = typeof rec.status === "string" ? rec.status : "?";
        const msg = typeof rec.message === "string" && rec.message ? ` — ${rec.message}` : "";
        summaryLines.push(`${tid.slice(0, 8)}: ${s}${msg}`);
      }
      const isError = status === "failed"
        || summaryLines.some((l) => /errored|not_found|interrupted/.test(l));
      const content = summaryLines.length > 0
        ? summaryLines.join("\n")
        : (status === "completed" ? "ok" : status);
      return [
        { type: "tool_use", id, name: toolName, input },
        { type: "tool_result", tool_use_id: id, content, is_error: isError },
      ];
    }

    if (type === "todo_list") {
      // codex 的 todo: { items: [{ text, completed: bool }] }
      // wand UI（renderTodoWrite）读的是 block.input.todos = [{content, status, activeForm}]
      // 这里做形状翻译；in_progress 状态 codex 不区分，全部 pending → completed 二值。
      const rawItems = Array.isArray(item.items) ? item.items : [];
      const todos = rawItems.map((entry) => {
        const rec = (entry && typeof entry === "object") ? entry as Record<string, unknown> : {};
        const text = typeof rec.text === "string" ? rec.text : "";
        const done = rec.completed === true;
        return {
          content: text,
          status: done ? "completed" : "pending",
          activeForm: text,
        };
      });
      return [{
        type: "tool_use",
        id,
        name: "TodoWrite",
        input: { todos },
      }];
    }

    if (type === "error") {
      // item-level error（不是 top-level error 事件，那个走 codexErrors / 退出报错路径）
      const message = this.extractCodexText(item) || "codex item error";
      return [{ type: "text", text: `❌ ${message}` }];
    }

    // unknown / 兜底：completed 时尝试取 text 字段免得 silently 丢
    if (completed) {
      const text = this.extractCodexText(item);
      if (text) return [{ type: "text", text }];
    }
    return [];
  }

  private upsertCodexBlock(blocks: ContentBlock[], block: ContentBlock): void {
    // tool_use 按 id 去重——file_change 在 item.started 已经 push 过一份 tool_use，
    // 到 item.completed 还会再发一份相同 id 的（带 status 更新），不去重就出现
    // 两张同名卡片。command_execution 不受影响（它在 completed 只 emit tool_result）。
    if (block.type === "tool_use") {
      const existingIndex = blocks.findIndex((existing) => existing.type === "tool_use" && existing.id === block.id);
      if (existingIndex >= 0) {
        blocks[existingIndex] = block;
        return;
      }
    }
    if (block.type === "tool_result") {
      const toolUseIndex = blocks.findIndex((existing) => existing.type === "tool_use" && existing.id === block.tool_use_id);
      if (toolUseIndex >= 0) {
        const nextIndex = toolUseIndex + 1;
        if (blocks[nextIndex]?.type === "tool_result" && blocks[nextIndex].tool_use_id === block.tool_use_id) {
          blocks[nextIndex] = block;
        } else {
          blocks.splice(nextIndex, 0, block);
        }
        return;
      }
    }
    blocks.push(block);
  }

  private extractCodexUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
    if (!source || typeof source !== "object") return undefined;
    const value = {
      inputTokens: typeof source.input_tokens === "number" ? source.input_tokens : undefined,
      outputTokens: typeof source.output_tokens === "number" ? source.output_tokens : undefined,
      cacheReadInputTokens: typeof source.cached_input_tokens === "number" ? source.cached_input_tokens : undefined,
      reasoningOutputTokens: typeof source.reasoning_output_tokens === "number" ? source.reasoning_output_tokens : undefined,
    };
    if (
      value.inputTokens === undefined
      && value.outputTokens === undefined
      && value.cacheReadInputTokens === undefined
      && value.reasoningOutputTokens === undefined
    ) {
      return undefined;
    }
    return value;
  }
}
