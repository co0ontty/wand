import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { query as sdkQuery, type Options as SdkOptions, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { prepareSessionWorktree } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  CardExpandDefaults, ContentBlock, ConversationTurn, EscalationScope,
  ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, SessionSource, StructuredSessionState,
  SubagentMeta, ToolUseBlock, WandConfig,
} from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { resolveSdkClaudeBinary } from "./claude-sdk-runner.js";
import { generateSessionTopic } from "./session-topic.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { buildCodexArgs } from "./structured-codex-adapter.js";
import {
  buildAppendSystemPromptParts,
  buildClaudeCliArgs,
  buildClaudeSdkThinking,
  derivePermissionPolicy,
} from "./structured-claude-adapter.js";
import { applyOpenCodeEvent, buildOpenCodeArgs } from "./structured-opencode-adapter.js";
import {
  defaultStructuredRunner,
  defaultStructuredState,
  isStructuredRunnerForProvider,
  normalizeThinkingEffort,
  resolveStructuredRunner,
} from "./structured-provider-common.js";

export {
  isStructuredRunnerForProvider,
  normalizeThinkingEffort,
  resolveStructuredRunner,
  thinkingEffortToClaudeCliEffort,
  thinkingEffortToCodexReasoningEffort,
  thinkingEffortToOpenCodeVariant,
  thinkingEffortToSdkBudget,
} from "./structured-provider-common.js";

interface CreateStructuredSessionOptions {
  cwd: string;
  mode: ExecutionMode;
  provider?: SessionProvider;
  runner?: SessionRunner;
  worktreeEnabled?: boolean;
  /** 用户指定的模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
  model?: string;
  /** 用户预设的思考深度。留空 / null 视为 off。 */
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  sessionSource?: SessionSource;
  automationId?: string;
  /**
   * 恢复用的初始会话 id：
   *   - Codex：历史 thread id，首条消息即 `codex exec ... resume <id>` 续接。
   *   - Claude：历史 session id，首条消息即 `--resume` / SDK resume 续接。
   * 留空表示新建会话。
   */
  claudeSessionId?: string;
}

/** The runner already persisted/emitted its detailed terminal snapshot. */
class PersistedStructuredRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedStructuredRunnerError";
  }
}

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

/**
 * Preserve both Responses content-part arrays and arbitrary structured tool output.
 * Arrays without a `type` discriminator (for example Codex tool_search results)
 * are serialized instead of being filtered to an empty result.
 */
export function normalizeStructuredToolResultContent(
  content: unknown,
): string | Array<{ type: string; [key: string]: unknown }> {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((item): item is { type: string; [key: string]: unknown } =>
      !!item && typeof item === "object" && typeof (item as any).type === "string",
    );
    if (parts.length === content.length) return parts;
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return typeof content === "undefined" || content === null ? "" : String(content);
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

/** Accumulated state while streaming a single claude -p response. */
interface StreamingTurnState {
  blocks: ContentBlock[];
  result: string;
  sessionId: string | null;
  model?: string;
  usage?: ConversationTurn["usage"];
  /**
   * codex item.id → index of the FIRST block this item produced in `blocks`.
   * Used on `item.updated` / `item.completed` to replace an in-place text /
   * thinking / TodoWrite card instead of duplicating it. tool_use ↔ tool_result
   * pairing for codex stays driven by `upsertCodexBlock` via matching ids.
   */
  codexBlockIndex?: Map<string, number>;
  /** Codex `file_change` only carries paths; snapshots provide the missing diff body. */
  codexFileSnapshots?: CodexFileSnapshotMap;
  cwd?: string;
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

function refreshEstimatedCodexUsage(turnState: StreamingTurnState): void {
  if (turnState.usage?.estimated !== true) return;
  turnState.usage = {
    outputTokens: estimateCodexOutputTokens(turnState.blocks),
    estimated: true,
  };
}

/**
 * Per-turn registry of Task tool_use_id → subagent meta. Populated when the
 * parent assistant emits Task tool_use blocks; consulted when subagent
 * messages arrive so we can stamp them with agentType / description and
 * the UI can render them as a separate persona.
 */
type TaskMetaMap = Map<string, { agentType?: string; description?: string }>;

function captureTaskMeta(blocks: ContentBlock[], registry: TaskMetaMap): void {
  for (const b of blocks) {
    if (b.type !== "tool_use") continue;
    if (registry.has(b.id)) continue;
    const input = b.input ?? {};
    // Claude SDK 把这类"派 subagent 干活"的内置工具叫做 "Agent"，CLI/旧版本里
    // 也叫过 "Task"。判定不靠工具名（容易随版本变），而是看 input 是否含有
    // `subagent_type` 字段——这是 Agent/Task 系列的唯一标志。
    const agentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
    if (!agentType && b.name !== "Task" && b.name !== "Agent") continue;
    const description = typeof input.description === "string" ? input.description : undefined;
    registry.set(b.id, { agentType, description });
  }
}

/**
 * Stamp every block with `__subagent` meta keyed to `parentToolUseId`. When
 * the id has no entry yet (rare race: subagent emits before we see the parent
 * Task tool_use), we still stamp the bare taskId so the UI can group blocks;
 * agentType / description backfill on later updates.
 */
function tagSubagentBlocks(
  blocks: ContentBlock[],
  parentToolUseId: string | null | undefined,
  registry: TaskMetaMap,
): ContentBlock[] {
  if (!parentToolUseId) return blocks;
  const meta = registry.get(parentToolUseId);
  const stamp: SubagentMeta = {
    taskId: parentToolUseId,
    ...(meta?.agentType ? { agentType: meta.agentType } : {}),
    ...(meta?.description ? { taskDescription: meta.description } : {}),
  };
  return blocks.map((block) => ({ ...block, __subagent: stamp } as ContentBlock));
}

/**
 * 给已被 captureTaskMeta 识别为 Task/Agent 的 tool_use block 本身也盖 __subagent 章。
 * taskId 用自己的 block.id —— 与子消息的 parent_tool_use_id（也等于这个 id）保持一致，
 * 前端 splitTurnBySubagent 按 taskId 分组时父 Task tool_use 和 SDK 转发的子消息能合并到同一段。
 */
function stampSelfTask(blocks: ContentBlock[], registry: TaskMetaMap): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool_use") return b;
    if (b.__subagent) return b; // 已盖章不重复（防止幂等问题）
    const meta = registry.get(b.id);
    if (!meta && b.name !== "Task" && b.name !== "Agent") return b;
    const stamp: SubagentMeta = {
      taskId: b.id,
      ...(meta?.agentType ? { agentType: meta.agentType } : {}),
      ...(meta?.description ? { taskDescription: meta.description } : {}),
    };
    return { ...b, __subagent: stamp } as ContentBlock;
  });
}

/**
 * 当父 assistant 在 parentToolUseId === null 的 user turn 里收到 Task 工具的 tool_result 时，
 * tagSubagentBlocks 不会被调用（它只在 parentToolUseId 非空时盖章）。这里按 tool_use_id
 * 反查 registry，给这条 tool_result 单独盖章，让前端能把它归到同一个 subagent 段。
 */
function stampParentTaskResults(blocks: ContentBlock[], registry: TaskMetaMap): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type !== "tool_result") return b;
    if (b.__subagent) return b;
    const meta = registry.get(b.tool_use_id);
    if (!meta) return b;
    const stamp: SubagentMeta = {
      taskId: b.tool_use_id,
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
      ...(meta.description ? { taskDescription: meta.description } : {}),
    };
    return { ...b, __subagent: stamp } as ContentBlock;
  });
}

const STREAM_EMIT_DEBOUNCE_MS = 16;
/** Min interval between full saveSession() calls for an in-progress streaming turn.
 *  saveSession serializes the entire messages array, so doing it on every NDJSON
 *  event is N². close-path always calls saveSession unconditionally to take the
 *  authoritative final snapshot. */
// Full message snapshots become increasingly expensive during long turns.
// Terminal paths always force an authoritative save, so a one-second crash
// checkpoint keeps recovery useful without rewriting megabytes five times a
// second on the event loop.
const STREAM_SAVE_THROTTLE_MS = 1_000;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;

interface StreamingCheckpointDirty {
  metadata: boolean;
  output: boolean;
  messages: boolean;
}

/**
 * 找出最后一条 assistant turn 中尚未配对 tool_result 的 AskUserQuestion tool_use。
 * 用来识别"刚被 SIGTERM 中断、正在等用户提交答案"的状态。
 */
function findUnpairedAskUserQuestion(
  messages: ConversationTurn[],
): { id: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turn.role !== "assistant") continue;
    for (const block of turn.content) {
      if (block.type === "tool_use" && block.name === "AskUserQuestion") {
        const toolUseId = block.id;
        // 检查后续 turn 中是否已有对应 tool_result
        let answered = false;
        for (let j = i + 1; j < messages.length; j++) {
          const nextTurn = messages[j];
          for (const nb of nextTurn.content) {
            if (nb.type === "tool_result" && nb.tool_use_id === toolUseId) {
              answered = true;
              break;
            }
          }
          if (answered) break;
        }
        if (!answered) return { id: toolUseId };
      }
    }
    // 只检查最后一条 assistant turn
    return null;
  }
  return null;
}

/** Enrich a snapshot with a derived summary from the first user message. */
function withSummary(snapshot: SessionSnapshot): SessionSnapshot {
  if (snapshot.summary) return snapshot;
  const messages = snapshot.messages ?? [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text.trim()) {
        return { ...snapshot, summary: block.text.trim().slice(0, 120) };
      }
    }
    break;
  }
  return snapshot;
}

/** Should we auto-approve permissions for this mode? */
function shouldAutoApproveForMode(mode: ExecutionMode): boolean {
  return mode === "full-access" || mode === "managed" || mode === "auto-edit";
}

function buildStructuredOutputPayload(snapshot: SessionSnapshot): ProcessEvent["data"] {
  return {
    output: snapshot.output,
    messages: snapshot.messages,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    title: snapshot.title,
    description: snapshot.description,
    summary: snapshot.description ?? snapshot.summary,
  };
}

/**
 * 返回最近一次真正提交给结构化会话的用户输入。
 *
 * 排队非空时，队尾才是“上一条提交”；否则回看当前正在处理的最后一个 user turn。
 * 这里只接受可无损还原成字符串的 text / tool_result，避免把图片等结构化内容误判
 * 成更早的纯文本输入。
 */
export function getLastSubmittedStructuredInput(snapshot: Pick<SessionSnapshot, "messages" | "queuedMessages">): string | null {
  const queue = snapshot.queuedMessages ?? [];
  for (let i = queue.length - 1; i >= 0; i--) {
    const queued = queue[i]?.trim();
    if (queued) return queued;
  }

  const messages = snapshot.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i];
    if (turn.role !== "user") continue;

    const textParts = turn.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text);
    if (textParts.length > 0) {
      const text = textParts.join("\n").trim();
      return text || null;
    }

    const toolResult = turn.content.find(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result" && typeof block.content === "string",
    );
    return toolResult && typeof toolResult.content === "string" ? toolResult.content.trim() || null : null;
  }
  return null;
}

/** 仅用于 in-flight 排队分支：连续两次内容相同则把后一次视为输入重放。 */
export function isDuplicateStructuredQueueInput(
  snapshot: Pick<SessionSnapshot, "messages" | "queuedMessages">,
  input: string,
): boolean {
  const prompt = input.trim();
  if (!prompt) return false;
  return getLastSubmittedStructuredInput(snapshot) === prompt;
}

function buildIncrementalStructuredPayload(
  snapshot: SessionSnapshot,
  cardDefaults: CardExpandDefaults,
): ProcessEvent["data"] {
  const messages = snapshot.messages ?? [];
  const lastTurn = messages.length > 0 ? messages[messages.length - 1] : undefined;
  // Streaming turn (index 0 here) is preserved verbatim; truncation only kicks
  // in if the live response is already bigger than the transport threshold,
  // matching the PTY runner's behaviour in process-manager.ts.
  const lastMessage = lastTurn ? truncateMessagesForTransport([lastTurn], cardDefaults, 0)[0] : undefined;
  return {
    incremental: true,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    lastMessage,
    messageCount: messages.length,
  };
}

export class StructuredSessionManager {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly pendingChildren = new Map<string, ChildProcess>();
  private readonly pendingSdkAbort = new Map<string, AbortController>();
  /**
   * Active SDK Query handle per session, kept around so we can call
   * `query.interrupt()` for a graceful stop instead of aborting via signal.
   * Only populated while an SDK call is in flight.
   */
  private readonly pendingSdkQueries = new Map<string, { interrupt(): Promise<void> }>();
  private readonly interruptedWith = new Map<string, string>();
  /**
   * Sessions where the current interrupt is a "queue promote" (用户从排队条点了「立即」
   * 把队首插队到 now)。退出处理三个分支默认会把 queuedMessages 清空——因为常规的
   * interrupt 语义是"算了，做这个"，把队列也作废。但 queue-promote 的语义是
   * "先做这条，剩下的队列还要继续"，所以这里打个标记，让退出 handler 保留 queue。
   * 收到后必须 delete 掉，避免下一次普通 interrupt 误带 flag。
   */
  private readonly preserveQueueOnInterrupt = new Set<string>();
  /** Last wall-clock time (ms) a streaming checkpoint reached SQLite. */
  private readonly lastStreamSaveAt = new Map<string, number>();
  private readonly streamCheckpointTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamCheckpointDirty = new Map<string, StreamingCheckpointDirty>();
  /**
   * Idempotency keys we've already accepted, mapped to their wall-clock timestamp.
   * Android WebView 在进程恢复时偶尔会重发上一个未收到响应的 POST（HTTP/2 stream
   * reset 等场景），客户端 JS 没有重试逻辑也拦不住。这里用 (sessionId, key) 永
   * 久去重，重复就抛错让前端弹 toast 提示，**不**做任何处理。timestamp 仅用于
   * map 大小溢出时按时间裁剪。
   */
  private readonly seenIdempotencyKeys = new Map<string, number>();
  private emitEvent: ((event: ProcessEvent) => void) | null = null;
  private archiveTimer: NodeJS.Timeout | null = null;
  private readonly topicRequests = new Set<string>();
  private readonly streamEmitTimers = new Set<NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly storage: WandStorage,
    private readonly config: WandConfig,
    private readonly logger: SessionLogger | null = null,
    private readonly sdkQueryFactory: typeof sdkQuery = sdkQuery,
  ) {
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "structured") continue;
      const restoredStatus = snapshot.status === "running" ? "idle" : snapshot.status;
      const storedProvider = snapshot.provider ?? snapshot.structuredState?.provider;
      const provider: SessionProvider = storedProvider === "codex" || storedProvider === "opencode"
        ? storedProvider
        : "claude";
      const storedRunner = snapshot.runner ?? snapshot.structuredState?.runner;
      // Legacy/corrupt snapshots are normalized on restore so send dispatch can
      // rely on the provider/runner invariant without making startup fail.
      const runner = isStructuredRunnerForProvider(provider, storedRunner)
        ? storedRunner
        : defaultStructuredRunner(provider, this.config.structuredRunner);
      const restored: SessionSnapshot = {
        ...snapshot,
        sessionKind: "structured",
        sessionSource: snapshot.sessionSource ?? "interactive",
        automationId: snapshot.automationId,
        provider,
        runner,
        status: restoredStatus,
        autoApprovePermissions: snapshot.autoApprovePermissions ?? shouldAutoApproveForMode(snapshot.mode),
        approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
        queuedMessages: snapshot.queuedMessages ?? [],
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          provider,
          runner,
          model: snapshot.structuredState?.model ?? snapshot.selectedModel ?? undefined,
          lastError: snapshot.structuredState?.lastError ?? null,
          inFlight: false,
          activeRequestId: null,
        },
        selectedModel: snapshot.selectedModel ?? null,
      };
      this.sessions.set(restored.id, restored);
      this.storage.saveSession(restored);
    }
    this.archiveExpiredSessions();
    this.archiveTimer = setInterval(() => {
      try { this.archiveExpiredSessions(); } catch (err) {
        console.error(`[StructuredSessionManager] archive scan failed: ${String(err)}`);
      }
    }, 60 * 1000);
    this.archiveTimer.unref?.();
  }

  private archiveExpiredSessions(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.archived || session.status === "running") continue;
      const referenceTime = session.endedAt ?? session.startedAt;
      const endedAtMs = Date.parse(referenceTime);
      if (!Number.isFinite(endedAtMs) || now - endedAtMs < ARCHIVE_AFTER_MS) continue;
      session.archived = true;
      session.archivedAt = new Date(now).toISOString();
      this.storage.updateSessionRuntimeMetadata(session);
    }
  }

  setEventEmitter(emitEvent: (event: ProcessEvent) => void): void {
    if (this.disposed) return;
    this.emitEvent = emitEvent;
  }

  /** Stop every runner and flush terminal state before storage is closed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.archiveTimer) {
      clearInterval(this.archiveTimer);
      this.archiveTimer = null;
    }
    for (const timer of this.streamEmitTimers) clearTimeout(timer);
    this.streamEmitTimers.clear();

    const activeSessionIds = new Set<string>([
      ...this.pendingChildren.keys(),
      ...this.pendingSdkQueries.keys(),
      ...this.pendingSdkAbort.keys(),
      ...Array.from(this.sessions.values())
        .filter((session) => session.structuredState?.inFlight)
        .map((session) => session.id),
    ]);
    for (const id of activeSessionIds) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const cancelled: SessionSnapshot = {
        ...session,
        status: "idle",
        exitCode: null,
        endedAt: null,
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
          inFlight: false,
          activeRequestId: null,
          lastError: null,
        },
      };
      this.sessions.set(id, cancelled);
      try { this.saveAuthoritativeSession(cancelled); } catch { /* best-effort shutdown flush */ }
    }

    for (const child of this.pendingChildren.values()) {
      try { child.kill(); } catch { /* ignore */ }
    }
    for (const query of this.pendingSdkQueries.values()) {
      void query.interrupt().catch(() => { /* ignore */ });
    }
    for (const controller of this.pendingSdkAbort.values()) controller.abort();
    this.pendingChildren.clear();
    this.pendingSdkQueries.clear();
    this.pendingSdkAbort.clear();
    this.interruptedWith.clear();
    this.preserveQueueOnInterrupt.clear();
    for (const timer of this.streamCheckpointTimers.values()) clearTimeout(timer);
    this.streamCheckpointTimers.clear();
    this.streamCheckpointDirty.clear();
    this.lastStreamSaveAt.clear();
    this.topicRequests.clear();
    this.emitEvent = null;
  }

  private trackStreamEmitTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
    this.streamEmitTimers.add(timer);
    return timer;
  }

  private clearStreamEmitTimer(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.streamEmitTimers.delete(timer);
  }

  /** Mark streaming payload dirty and enforce both leading and trailing checkpoints. */
  private saveStreamingSnapshot(
    snapshot: SessionSnapshot,
    changed: Partial<StreamingCheckpointDirty> = { messages: true, output: true },
  ): void {
    if (this.disposed) return;
    const dirty = this.streamCheckpointDirty.get(snapshot.id) ?? { metadata: false, output: false, messages: false };
    if (changed.metadata) dirty.metadata = true;
    if (changed.output) dirty.output = true;
    if (changed.messages) dirty.messages = true;
    this.streamCheckpointDirty.set(snapshot.id, dirty);

    const now = Date.now();
    const last = this.lastStreamSaveAt.get(snapshot.id) ?? 0;
    const remaining = STREAM_SAVE_THROTTLE_MS - (now - last);
    if (remaining <= 0) {
      this.flushStreamingCheckpoint(snapshot.id);
      return;
    }
    if (this.streamCheckpointTimers.has(snapshot.id)) return;
    const timer = setTimeout(() => {
      this.streamCheckpointTimers.delete(snapshot.id);
      if (!this.disposed) this.flushStreamingCheckpoint(snapshot.id);
    }, remaining);
    timer.unref?.();
    this.streamCheckpointTimers.set(snapshot.id, timer);
  }

  private flushStreamingCheckpoint(sessionId: string): void {
    const timer = this.streamCheckpointTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.streamCheckpointTimers.delete(sessionId);
    }
    const dirty = this.streamCheckpointDirty.get(sessionId);
    const snapshot = this.sessions.get(sessionId);
    if (!dirty || !snapshot) {
      this.streamCheckpointDirty.delete(sessionId);
      return;
    }
    if (dirty.metadata) this.storage.updateSessionRuntimeMetadata(snapshot);
    if (dirty.messages) {
      this.storage.checkpointSessionMessages(
        sessionId,
        snapshot.messages ?? [],
        snapshot.structuredState,
        dirty.output ? snapshot.output : undefined,
      );
    } else if (dirty.output) {
      this.storage.checkpointSessionOutput(sessionId, snapshot.output);
    }
    this.streamCheckpointDirty.delete(sessionId);
    this.lastStreamSaveAt.set(sessionId, Date.now());
  }

  private clearStreamingCheckpoint(sessionId: string): void {
    this.cancelStreamingCheckpointTimer(sessionId);
    this.streamCheckpointDirty.delete(sessionId);
    this.lastStreamSaveAt.delete(sessionId);
  }

  private cancelStreamingCheckpointTimer(sessionId: string): void {
    const timer = this.streamCheckpointTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.streamCheckpointTimers.delete(sessionId);
  }

  private saveAuthoritativeSession(snapshot: SessionSnapshot): void {
    this.storage.saveSession(snapshot);
    this.clearStreamingCheckpoint(snapshot.id);
  }

  private checkpointSessionMessages(snapshot: SessionSnapshot, includeOutput = false): void {
    this.storage.updateSessionRuntimeMetadata(snapshot);
    this.storage.checkpointSessionMessages(
      snapshot.id,
      snapshot.messages ?? [],
      snapshot.structuredState,
      includeOutput ? snapshot.output : undefined,
    );
  }

  list(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .map(withSummary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Return lightweight snapshots for the session list (no output/messages). */
  listSlim(): SessionSnapshot[] {
    return Array.from(this.sessions.values())
      .map((s) => {
        const enriched = withSummary(s);
        const { output: _o, messages: _m, ...slim } = enriched;
        return { ...slim, output: "" } as SessionSnapshot;
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): SessionSnapshot | null {
    const s = this.sessions.get(id);
    return s ? withSummary(s) : null;
  }

  setSessionTopic(id: string, title: string, description: string): SessionSnapshot {
    const current = this.requireSession(id);
    const updated: SessionSnapshot = { ...current, title, description, summary: description };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /**
   * Update worktree merge progress on the canonical in-memory snapshot before
   * persisting it. A null result means this manager does not own the session.
   */
  setWorktreeMergeState(
    id: string,
    status: SessionSnapshot["worktreeMergeStatus"],
    info: SessionSnapshot["worktreeMergeInfo"],
  ): SessionSnapshot | null {
    const current = this.sessions.get(id);
    if (!current) return null;
    const updated: SessionSnapshot = {
      ...current,
      worktreeMergeStatus: status,
      worktreeMergeInfo: info ?? null,
    };
    this.sessions.set(id, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: {
        sessionKind: "structured",
        worktreeMergeStatus: status,
        worktreeMergeInfo: updated.worktreeMergeInfo,
      },
    });
    return updated;
  }

  private maybeGenerateSessionTopic(id: string, input: string): void {
    const session = this.sessions.get(id);
    if (this.disposed || !session || session.title || this.topicRequests.has(id)) return;
    this.topicRequests.add(id);
    void generateSessionTopic(input, session.cwd, this.config.language)
      .then(({ title, description }) => {
        if (!this.disposed && this.sessions.has(id)) this.setSessionTopic(id, title, description);
      })
      .catch((error) => console.error(`[StructuredSessionManager] Failed to generate session topic ${id}:`, getErrorMessage(error)))
      .finally(() => this.topicRequests.delete(id));
  }

  createSession(options: CreateStructuredSessionOptions): SessionSnapshot {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const requestedProvider: unknown = options.provider ?? "claude";
    if (requestedProvider !== "claude" && requestedProvider !== "codex" && requestedProvider !== "opencode") {
      throw new Error(`不支持的结构化 provider: ${String(requestedProvider)}`);
    }
    const provider: SessionProvider = requestedProvider;
    const runner = resolveStructuredRunner(provider, options.runner, this.config.structuredRunner);
    const baseCwd = resolveSessionCwd(options.cwd, this.config.defaultCwd);
    const worktreeSetup = options.worktreeEnabled
      ? prepareSessionWorktree({ cwd: baseCwd, sessionId: id })
      : null;
    const selectedModel = options.model?.trim() || null;
    const initialThinkingEffort = normalizeThinkingEffort(options.thinkingEffort);
    const snapshot: SessionSnapshot = {
      id,
      sessionKind: "structured",
      sessionSource: options.sessionSource ?? "interactive",
      automationId: options.automationId,
      provider,
      runner,
      command:
        provider === "codex"
          ? "codex exec --json"
          : provider === "opencode"
            ? "opencode run --format json"
          : runner === "claude-sdk"
            ? "claude-agent-sdk (stream-json)"
            : "claude -p --output-format stream-json",
      cwd: worktreeSetup?.cwd ?? baseCwd,
      mode: options.mode,
      worktreeEnabled: Boolean(worktreeSetup),
      worktree: worktreeSetup?.worktree ?? null,
      status: "idle",
      exitCode: null,
      startedAt,
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: options.claudeSessionId?.trim() || null,
      messages: [],
      queuedMessages: [],
      structuredState: {
        provider,
        runner,
        model: selectedModel ?? undefined,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
      autoRecovered: false,
      autoApprovePermissions: shouldAutoApproveForMode(options.mode),
      approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
      selectedModel,
      thinkingEffort: initialThinkingEffort,
    };

    this.sessions.set(id, snapshot);
    this.storage.saveSession(snapshot);
    this.emit({ type: "started", sessionId: id, data: { sessionKind: "structured" } });

    return snapshot;
  }

  async sendMessage(
    id: string,
    input: string,
    opts?: { interrupt?: boolean; idempotencyKey?: string; preserveQueue?: boolean; queueAlreadyRemoved?: boolean },
  ): Promise<SessionSnapshot> {
    if (this.disposed) throw new Error("StructuredSessionManager has been disposed.");
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    this.maybeGenerateSessionTopic(id, prompt);
    if (opts?.idempotencyKey) {
      const mapKey = `${id}:${opts.idempotencyKey}`;
      if (this.seenIdempotencyKeys.has(mapKey)) {
        const err = new Error("检测到重复发送，已拦截。") as Error & { code?: string };
        err.code = "duplicate_idempotency_key";
        throw err;
      }
      this.seenIdempotencyKeys.set(mapKey, Date.now());
      // 防止 map 无限增长：超过 1024 条时按时间裁掉一半最早的
      if (this.seenIdempotencyKeys.size > 1024) {
        const sorted = Array.from(this.seenIdempotencyKeys.entries()).sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < sorted.length / 2; i++) {
          this.seenIdempotencyKeys.delete(sorted[i][0]);
        }
      }
    }
    if (session.structuredState?.inFlight) {
      const child = this.pendingChildren.get(id);
      const sdkAbort = this.pendingSdkAbort.get(id);
      const sdkQueryHandle = this.pendingSdkQueries.get(id);
      // ChildProcess.killed only means kill() successfully sent a signal; the
      // process can keep running until its close/error callback releases this
      // exact handle. Treat map ownership as the authoritative in-flight state.
      const childActive = Boolean(child);
      const sdkAlive = Boolean(sdkQueryHandle || (sdkAbort && !sdkAbort.signal.aborted));
      if (!childActive && !sdkAlive) {
        if (child) this.releasePendingChild(id, child);
        if (sdkAbort) this.releasePendingSdkAbort(id, sdkAbort);
        const recovered: SessionSnapshot = {
          ...session,
          status: "idle",
          endedAt: session.endedAt ?? new Date().toISOString(),
          structuredState: {
            ...(session.structuredState as StructuredSessionState),
            inFlight: false,
            activeRequestId: null,
          },
        };
        this.sessions.set(id, recovered);
        this.storage.updateSessionRuntimeMetadata(recovered);
        session = recovered;
      } else if (opts?.interrupt) {
        this.interruptedWith.set(id, prompt);
        if (opts.preserveQueue) {
          this.preserveQueueOnInterrupt.add(id);
          // 「立即发送」排队条某一条：interrupt 把它作为新输入重发，但该条仍留在
          // queuedMessages 里。必须在这里把它从队列摘掉一次，否则 preserveQueue 会
          // 原样保留整条队列，待 interruptPrompt 跑完 flushNextQueuedMessage 会把它
          // 当成普通排队再发一遍（重复发送）。旧客户端没有走 promote endpoint，
          // 服务端只能按文本删第一处匹配；新客户端会带 queueAlreadyRemoved 跳过这里。
          if (!opts.queueAlreadyRemoved) {
            const queue = session.queuedMessages ?? [];
            const removeAt = queue.indexOf(prompt);
            if (removeAt !== -1) {
              const trimmedQueue = queue.slice(0, removeAt).concat(queue.slice(removeAt + 1));
              session = { ...session, queuedMessages: trimmedQueue };
              this.sessions.set(id, session);
              this.storage.updateSessionRuntimeMetadata(session);
              this.emitStructuredSnapshot(session);
            }
          }
        } else {
          this.preserveQueueOnInterrupt.delete(id);
        }
        if (childActive && child) {
          try { child.kill("SIGTERM"); } catch (_err) { /* ignore */ }
        }
        if (sdkQueryHandle) {
          void sdkQueryHandle.interrupt().catch(() => { /* ignore */ });
        }
        if (sdkAbort) sdkAbort.abort();
        return session;
      } else {
        const queue = [...(session.queuedMessages ?? [])];
        if (isDuplicateStructuredQueueInput(session, prompt)) {
          const err = new Error("与上一条消息相同，已忽略，不会加入排队。") as Error & { code?: string };
          err.code = "duplicate_queued_message";
          throw err;
        }
        if (queue.length >= 10) {
          throw new Error("排队消息已满（最多 10 条），请等待当前消息处理完成。");
        }
        const queued: SessionSnapshot = {
          ...session,
          queuedMessages: [...queue, prompt],
        };
        this.sessions.set(id, queued);
        this.storage.updateSessionRuntimeMetadata(queued);
        this.emitStructuredSnapshot(queued);
        return queued;
      }
    }

    // 检测上一轮 assistant 是否有未配对的 AskUserQuestion tool_use（说明前一次
    // child 是被 SIGTERM 主动 kill 的，正在等用户回答）。如果有，把这次的输入打包
    // 成 tool_result 注入到 messages，让 UI 把卡片渲染为 answered。
    const pendingAsk = findUnpairedAskUserQuestion(session.messages ?? []);
    const userTurn: ConversationTurn = pendingAsk
      ? {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: pendingAsk.id,
              content: prompt,
              is_error: false,
            },
          ],
        }
      : {
          role: "user",
          content: [{ type: "text", text: prompt }],
        };
    const requestId = randomUUID();
    const updated: SessionSnapshot = {
      ...session,
      status: "running",
      exitCode: null,
      endedAt: null,
      messages: [...(session.messages ?? []), userTurn],
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: true,
        activeRequestId: requestId,
        lastError: null,
      },
    };
    this.sessions.set(id, updated);
    this.checkpointSessionMessages(updated);
    this.emitStructuredSnapshot(updated);
    this.emit({
      type: "status",
      sessionId: id,
      data: { status: "running", sessionKind: "structured", queuedMessages: updated.queuedMessages, structuredState: updated.structuredState },
    });

    // 续接 AskUserQuestion 的两条不同路线：
    //   - CLI runner (`claude -p`)：stdin 是 ignore，没有 tool_result 回传通道，
    //     只能把答案当作普通文本塞回去，靠提示词让 Claude 自己脑补"这是工具回答"。
    //   - SDK runner：streaming input mode 下 prompt 是 AsyncIterable，可以把
    //     用户答案直接 yield 成真正的 tool_result block，对 Claude 来说就是标准
    //     的工具结果，不需要任何 hack。runner 自己从 session.messages 末尾读取
    //     新加的 userTurn，所以传原始 prompt 即可。
    const cliClaudePrompt = pendingAsk
      ? `[对刚才 AskUserQuestion 工具的回答 — 结构化模式不支持工具结果回传，下面是用户从选项中的选择]\n${prompt}`
      : prompt;

    try {
      const provider = updated.provider ?? updated.structuredState?.provider ?? "claude";
      const runner = updated.runner ?? updated.structuredState?.runner;
      if (!isStructuredRunnerForProvider(provider, runner)) {
        throw new Error(`会话 runner ${String(runner)} 与 provider ${provider} 不匹配。`);
      }
      if (provider === "codex") {
        await this.runCodexStreaming(id, updated, prompt, requestId);
      } else if (provider === "opencode") {
        await this.runOpenCodeStreaming(id, updated, prompt, requestId);
      } else if (runner === "claude-sdk") {
        await this.runClaudeSdkStreaming(id, updated, prompt, requestId);
      } else {
        await this.runClaudeStreaming(id, updated, cliClaudePrompt, requestId);
      }
      const finished = this.requireSession(id);
      return finished;
    } catch (error) {
      const message = getErrorMessage(error);
      // Close handlers use this tagged error after they have already persisted
      // the detailed failure. Re-throw even if an ended-event listener removed
      // the session synchronously; there is no request-id marker to leak.
      if (error instanceof PersistedStructuredRunnerError) throw error;
      const current = this.sessions.get(id);
      if (!current) throw error;
      // stop() or a newer turn may have invalidated this execution while its
      // runner was unwinding. A stale rejection must never fail the new turn.
      if (!this.isCurrentRequest(id, requestId)) {
        return current;
      }
      const failed: SessionSnapshot = {
        ...current,
        status: "failed",
        exitCode: 1,
        endedAt: new Date().toISOString(),
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          inFlight: false,
          activeRequestId: null,
          lastError: message,
        },
      };
      this.sessions.set(id, failed);
      this.saveAuthoritativeSession(failed);
      this.emit({
        type: "status",
        sessionId: id,
        data: { status: failed.status, error: message, sessionKind: "structured", queuedMessages: failed.queuedMessages, structuredState: failed.structuredState },
      });
      this.emitStructuredSnapshot(failed, "ended");
      throw error;
    }
  }

  /**
   * Reorder the pending queued messages. `order` is a permutation of the current
   * indices, e.g. `[2, 0, 1]` means "move the third queued message to the front,
   * push the original first to position #2". Throws if the permutation is
   * malformed (length mismatch / duplicate / out-of-range). 不允许在 inFlight
   * 期间改"已经被 flushNextQueuedMessage 拿走的队首"，但本方法只动 queue 数组
   * 本身，flushNext 在另一段时序里读 sessions.get(...) 当前快照，已经天然安全。
   */
  reorderQueuedMessages(sessionId: string, order: number[]): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Array.isArray(order) || order.length !== queue.length) {
      throw new Error("排序长度与当前队列不一致，请刷新后重试。");
    }
    const seen = new Set<number>();
    for (const idx of order) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= queue.length || seen.has(idx)) {
        throw new Error("排序参数无效。");
      }
      seen.add(idx);
    }
    const reordered = order.map((idx) => queue[idx]);
    const updated: SessionSnapshot = { ...session, queuedMessages: reordered };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Remove a single queued message by index. */
  deleteQueuedMessage(sessionId: string, index: number): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      throw new Error("队列中没有该条消息（可能已被处理）。");
    }
    const next = queue.slice(0, index).concat(queue.slice(index + 1));
    const updated: SessionSnapshot = { ...session, queuedMessages: next };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /**
   * Remove one queued message by index before sending it. Keeping this operation
   * on the server prevents clients from re-sending the text while the original
   * queue entry remains available for the automatic flush path.
   */
  async promoteQueuedMessage(
    sessionId: string,
    index: number,
    expectedText?: string,
    idempotencyKey?: string,
  ): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId);
    if (idempotencyKey && this.seenIdempotencyKeys.has(`${sessionId}:${idempotencyKey}`)) {
      return session;
    }
    const queue = session.queuedMessages ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
      throw new Error("队列中没有该条消息（可能已被处理）。");
    }
    if (expectedText !== undefined && queue[index] !== expectedText) {
      throw new Error("排队消息已变化，请按最新顺序重试。");
    }

    const prompt = queue[index];
    const remaining = queue.slice(0, index).concat(queue.slice(index + 1));
    const inFlight = session.status === "running" && session.structuredState?.inFlight === true;
    const updated: SessionSnapshot = { ...session, queuedMessages: remaining };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);

    try {
      return await this.sendMessage(sessionId, prompt, {
        interrupt: inFlight,
        preserveQueue: inFlight,
        queueAlreadyRemoved: true,
        idempotencyKey,
      });
    } catch {
      // Once the item has been promoted it must not return to the queue: the
      // send path may have already persisted its user turn before a runner error.
      return this.requireSession(sessionId);
    }
  }

  /** Clear all queued messages. No-op when queue is already empty. */
  clearQueuedMessages(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!session.queuedMessages || session.queuedMessages.length === 0) {
      return session;
    }
    const updated: SessionSnapshot = { ...session, queuedMessages: [] };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Update the selected model for a structured session. Takes effect on the next spawn. */
  setSessionModel(sessionId: string, model: string | null): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const normalized = model?.trim() || null;
    const updated: SessionSnapshot = {
      ...session,
      selectedModel: normalized,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        model: normalized ?? undefined,
      },
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", selectedModel: normalized, structuredState: updated.structuredState },
    });
    return updated;
  }

  /**
   * Update the thinking-effort level for a structured session. Takes effect on
   * the next spawn / next message (SDK runner injects `thinking`, Claude CLI
   * runner passes `--effort`, codex runner overrides `model_reasoning_effort`).
   */
  setSessionThinkingEffort(
    sessionId: string,
    effort: SessionSnapshot["thinkingEffort"],
  ): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const normalized = normalizeThinkingEffort(effort);
    const updated: SessionSnapshot = {
      ...session,
      thinkingEffort: normalized,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", thinkingEffort: normalized },
    });
    return updated;
  }

  /**
   * Switch the execution mode of a structured session mid-flight. Takes effect on
   * the next message/query — permission policy, append-system-prompt and CLI flags
   * are all re-derived from session.mode per turn. Mirrors setSessionModel; also
   * re-syncs autoApprovePermissions so the permission posture matches the new mode.
   */
  setSessionMode(sessionId: string, mode: ExecutionMode): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const autoApprove = shouldAutoApproveForMode(mode);
    const updated: SessionSnapshot = {
      ...session,
      mode,
      autoApprovePermissions: autoApprove,
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", mode, autoApprovePermissions: autoApprove },
    });
    return updated;
  }

  /** Toggle auto-approve for the session. */
  toggleAutoApprove(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const newVal = !session.autoApprovePermissions;
    const updated: SessionSnapshot = { ...session, autoApprovePermissions: newVal };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    return updated;
  }

  /** Resolve a specific escalation by requestId. */
  resolveEscalation(sessionId: string, requestId: string, resolution: unknown): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const pending = session.pendingEscalation;
    if (!pending) {
      throw new Error("当前会话没有待处理的授权请求。");
    }
    if (pending.requestId !== requestId) {
      throw new Error("授权请求已失效，请刷新后重试。");
    }
    if (resolution !== "approve_once" && resolution !== "approve_turn" && resolution !== "deny") {
      throw new Error("resolution 必须是 approve_once、approve_turn 或 deny。");
    }
    const approved = resolution !== "deny";
    const scope = pending.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: {
        requestId: pending.requestId,
        resolution,
        reason: approved ? "user_approved" : "user_denied",
      },
    };
    this.sessions.set(sessionId, updated);
    this.storage.updateSessionRuntimeMetadata(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { permissionBlocked: false, approvalStats: updated.approvalStats, sessionKind: "structured" },
    });
    return updated;
  }

  stop(id: string): SessionSnapshot {
    const session = this.requireSession(id);
    this.interruptedWith.delete(id);
    this.preserveQueueOnInterrupt.delete(id);
    // Clearing activeRequestId is the generation barrier: late data/close callbacks
    // from the cancelled runner can no longer mutate this session or a replacement turn.
    // 主动停止只是取消「当前回合」，结构化会话本身并没有结束——置为 idle 而非 stopped。
    // 这样前端不会进入"会话已结束/恢复会话"终止态，输入框保持可用，直接展示历史内容。
    const cancelled: SessionSnapshot = {
      ...session,
      status: "idle",
      exitCode: null,
      endedAt: null,
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(id, cancelled);

    const child = this.pendingChildren.get(id);
    if (child) {
      child.kill();
      this.releasePendingChild(id, child);
    }
    // SDK runner：先尝试 query.interrupt() 优雅停止，失败再走 abort。
    // 两个都清掉避免后续重复操作。
    const sdkQuery = this.pendingSdkQueries.get(id);
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.releasePendingSdkQuery(id, sdkQuery);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.releasePendingSdkAbort(id, sdkAbort);
    }
    this.saveAuthoritativeSession(cancelled);
    // 仍发 "ended" 事件让各端停掉"回复中"指示 / 灵动岛，但携带的 status 是 idle。
    this.emitStructuredSnapshot(cancelled, "ended");
    return cancelled;
  }

  delete(id: string): void {
    const child = this.pendingChildren.get(id);
    const sdkQuery = this.pendingSdkQueries.get(id);
    const sdkAbort = this.pendingSdkAbort.get(id);
    // Invalidate callback ownership before signalling the runner. Abort/kill can
    // synchronously wake listeners in some SDK/ChildProcess implementations.
    this.sessions.delete(id);
    if (child) {
      child.kill();
      this.releasePendingChild(id, child);
    }
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.releasePendingSdkQuery(id, sdkQuery);
    }
    if (sdkAbort) {
      sdkAbort.abort();
      this.releasePendingSdkAbort(id, sdkAbort);
    }
    this.clearStreamingCheckpoint(id);
    this.interruptedWith.delete(id);
    this.preserveQueueOnInterrupt.delete(id);
    this.storage.deleteSession(id);
    this.logger?.deleteSession(id);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireSession(id: string): SessionSnapshot {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("未找到该结构化会话。");
    }
    return session;
  }

  /** True only while this exact turn still owns the session's mutable state. */
  private isCurrentRequest(sessionId: string, requestId: string): boolean {
    return this.sessions.get(sessionId)?.structuredState?.activeRequestId === requestId;
  }

  private currentSessionForRequest(sessionId: string, requestId: string): SessionSnapshot | null {
    if (!this.isCurrentRequest(sessionId, requestId)) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  /** Delete a handle only if it still belongs to the execution doing cleanup. */
  private releasePendingChild(sessionId: string, child: ChildProcess): boolean {
    if (this.pendingChildren.get(sessionId) !== child) return false;
    this.pendingChildren.delete(sessionId);
    return true;
  }

  private releasePendingSdkAbort(sessionId: string, controller: AbortController): boolean {
    if (this.pendingSdkAbort.get(sessionId) !== controller) return false;
    this.pendingSdkAbort.delete(sessionId);
    return true;
  }

  private releasePendingSdkQuery(sessionId: string, query: { interrupt(): Promise<void> }): boolean {
    if (this.pendingSdkQueries.get(sessionId) !== query) return false;
    this.pendingSdkQueries.delete(sessionId);
    return true;
  }

  private emitStructuredSnapshot(session: SessionSnapshot, eventType: "output" | "ended" = "output"): void {
    // 排队消息只通过 payload.queuedMessages 单独下发，由各端在消息卡片外的「排队条」
    // 里纵向渲染——绝不再把它们当成 __queued 占位 turn 混进 messages 消息流里，否则会
    // 和排队条重复显示（旧的「显示异常」根因）。
    const payload = buildStructuredOutputPayload(session) as Record<string, unknown>;
    const data = {
      ...payload,
      status: session.status,
      exitCode: session.exitCode,
    };
    this.emit({
      type: eventType,
      sessionId: session.id,
      data,
    });
  }

  private async flushNextQueuedMessage(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const current = this.sessions.get(sessionId);
    if (!current || (current.queuedMessages?.length ?? 0) === 0) {
      return;
    }
    if (current.structuredState?.inFlight) {
      return;
    }
    const [nextInput, ...restQueue] = current.queuedMessages ?? [];
    if (!nextInput) {
      return;
    }
    const nextSession: SessionSnapshot = {
      ...current,
      queuedMessages: restQueue,
    };
    this.sessions.set(sessionId, nextSession);
    this.storage.updateSessionRuntimeMetadata(nextSession);
    this.emitStructuredSnapshot(nextSession);
    try {
      await this.sendMessage(sessionId, nextInput);
    } catch (error) {
      console.error("[WAND] flushNextQueuedMessage failed:", error);
      // 发送失败时把消息放回队首，避免永久丢失
      const afterFail = this.sessions.get(sessionId);
      if (afterFail) {
        const rescued: SessionSnapshot = {
          ...afterFail,
          queuedMessages: [nextInput, ...(afterFail.queuedMessages ?? [])],
        };
        this.sessions.set(sessionId, rescued);
        this.storage.updateSessionRuntimeMetadata(rescued);
        this.emitStructuredSnapshot(rescued);
      }
    }
  }

  private emit(event: ProcessEvent): void {
    if (!this.disposed && this.emitEvent) {
      this.emitEvent(event);
    }
  }

  private incrementApprovalStats(session: SessionSnapshot, scope: EscalationScope): void {
    const prev = session.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 };
    const stats = { ...prev };
    if (scope === "run_command" || scope === "dangerous_shell") {
      stats.command++;
    } else if (scope === "write_file") {
      stats.file++;
    } else {
      stats.tool++;
    }
    stats.total++;
    session.approvalStats = stats;
  }

  // ---------------------------------------------------------------------------
  // Streaming codex exec --json execution
  // ---------------------------------------------------------------------------

  private runCodexStreaming(sessionId: string, session: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = buildCodexArgs(session);
      const spawnedAt = new Date().toISOString();
      const child = spawn("codex", args, {
        cwd: session.cwd,
        env: buildChildEnv(this.config.inheritEnv !== false),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.logger?.appendStructuredSpawn(sessionId, {
        kind: "codex-exec",
        provider: "codex",
        pid: child.pid ?? null,
        cwd: session.cwd,
        args,
        prompt: prompt.slice(0, 2048),
        promptLength: prompt.length,
        threadId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(prompt);

      const turnState: StreamingTurnState = {
        blocks: [],
        result: "",
        sessionId: session.claudeSessionId,
        model: session.selectedModel ?? session.structuredState?.model,
        usage: { outputTokens: 0, estimated: true },
        codexBlockIndex: new Map(),
        codexFileSnapshots: new Map(),
        cwd: session.cwd,
      };
      let lineBuf = "";
      let stderr = "";
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      // codex 把所有错误（包括重试日志和最终失败原因）都通过 stdout 的 NDJSON 事件
      // 输出，stderr 通常是空的。我们在 processLine 里收集这些，然后在 close 中
      // 决定真正的报错文本。
      const codexErrors: string[] = [];
      let codexTurnFailed: string | null = null;

      const flushEmit = (): void => {
        if (emitTimer) {
          this.clearStreamEmitTimer(emitTimer);
          emitTimer = null;
        }
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) return;
        this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
      };

      const syncSnapshot = (): void => {
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) return;
        refreshEstimatedCodexUsage(turnState);
        const inProgressTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = inProgressTurn;
        } else {
          msgs.push(inProgressTurn);
        }
        const patched: SessionSnapshot = {
          ...current,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          output: turnState.result || current.output,
          structuredState: {
            ...(current.structuredState as StructuredSessionState),
            model: turnState.model ?? current.structuredState?.model,
          },
        };
        this.sessions.set(sessionId, patched);
        this.saveStreamingSnapshot(patched);
      };

      const processLine = (line: string): void => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try { parsed = JSON.parse(trimmed); } catch { return; }
        this.logger?.appendStreamEvent(sessionId, parsed);
        const event = this.unwrapCodexStreamEvent(parsed);
        if (event?.type === "thread.started" && typeof event.thread_id === "string") {
          turnState.sessionId = event.thread_id;
          syncSnapshot();
          return;
        }
        if (event?.type === "item.started" && asRecord(event.item)) {
          this.applyCodexItem(turnState, event.item as Record<string, unknown>, "started");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (event?.type === "item.updated" && asRecord(event.item)) {
          // codex `item.updated` 重新发送完整 ThreadItem（不是 delta）。
          // 对 text/thinking/TodoWrite 走 codexBlockIndex 替换；对 tool_use
          // 仍然按现有 id 复用，避免重复卡片。
          this.applyCodexItem(turnState, event.item as Record<string, unknown>, "updated");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (event?.type === "item.completed" && asRecord(event.item)) {
          this.applyCodexItem(turnState, event.item as Record<string, unknown>, "completed");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (event?.type === "turn.completed") {
          turnState.usage = this.extractCodexUsage(asRecord(event.usage) ?? undefined) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (event?.type === "token_count") {
          const info = asRecord(event.info);
          const lastUsage = asRecord(info?.last_token_usage);
          turnState.usage = this.extractCodexUsage(lastUsage ?? undefined) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (this.applyCodexLooseEvent(turnState, event)) {
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (event?.type === "error") {
          const message = typeof event.message === "string" ? event.message : "";
          if (message) codexErrors.push(message);
          return;
        }
        if (event?.type === "turn.failed") {
          const errObj = (event.error && typeof event.error === "object") ? event.error as Record<string, unknown> : null;
          const message = (errObj && typeof errObj.message === "string" && errObj.message)
            || (typeof event.message === "string" ? event.message : "")
            || "codex turn failed";
          codexTurnFailed = message;
          return;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          settled = true;
          resolve();
          return;
        }
        settled = true;
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "codex-exec-error",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          spawnError: error.message,
        });
        // spawn 直接失败（最常见是 ENOENT —— PATH 里找不到 codex 可执行文件）。
        // 之前只 reject(error)，外层 catch 会把 error.message 直接当 lastError，
        // 用户看到的就是裸的 "spawn codex ENOENT"，没法快速反应。这里加一层
        // 包装把上下文（runner 名 + 常见排查建议）拼好。
        const nodeErr = error as NodeJS.ErrnoException;
        const hint = nodeErr.code === "ENOENT"
          ? "（PATH 中找不到 codex 可执行文件；请确认 codex 已安装，或重跑 `wand service:install` 刷新服务的 PATH）"
          : "";
        reject(new Error(`codex exec 启动失败：${error.message}${hint}`));
      });

      child.on("close", (code, signal) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          if (emitTimer) this.clearStreamEmitTimer(emitTimer);
          settled = true;
          resolve();
          return;
        }
        if (lineBuf.trim()) {
          processLine(lineBuf);
          lineBuf = "";
        }
        flushEmit();
        const closedAt = new Date().toISOString();
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "codex-exec-close",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt,
          exitCode: code,
          stderrTail: stderr.slice(-2048),
          codexErrors,
          codexTurnFailed,
        });
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) {
          settled = true;
          resolve();
          return;
        }
        // 主动中断时（interruptedWith 里有新消息），不走失败路径
        const interruptedByUser = this.interruptedWith.has(sessionId);
        const interruptPrompt = this.interruptedWith.get(sessionId);
        // codex 把模型/网络/沙箱等错误写到 stdout 的 NDJSON 流（type: error / turn.failed），
        // 而不是 stderr。我们以 turn.failed 的 message 为准，其次是最后一个 error 事件。
        const codexFailed = codexTurnFailed !== null;
        if ((codexFailed || (code !== 0 && code !== null) || signal) && !interruptedByUser) {
          const errorText = this.formatStructuredExitError("codex exec", code, signal, {
            stderr,
            primary: codexTurnFailed,
            extras: codexErrors,
          });
          const exitForSnapshot = typeof code === "number" ? code : 1;
          const failed = this.finishStructuredFailure(current, exitForSnapshot, errorText, turnState);
          this.sessions.set(sessionId, failed);
          this.saveAuthoritativeSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          settled = true;
          reject(new PersistedStructuredRunnerError(errorText));
          return;
        }
        const msgs = this.buildCompletedAssistantMessages(current, turnState);
        const keepRunning = !!interruptPrompt;
        const finished: SessionSnapshot = {
          ...current,
          status: keepRunning ? "running" : "idle",
          exitCode: keepRunning ? null : 0,
          endedAt: keepRunning ? null : new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
          pendingEscalation: null,
          permissionBlocked: false,
          structuredState: {
            ...(current.structuredState as StructuredSessionState),
            model: turnState.model ?? current.structuredState?.model,
            inFlight: false,
            activeRequestId: null,
            lastError: null,
          },
        };
        this.sessions.set(sessionId, finished);
        this.saveAuthoritativeSession(finished);
        this.emitStructuredSnapshot(finished);
        if (!keepRunning) {
          this.emitStructuredSnapshot(finished, "ended");
        }
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          // 把"保留队列"标记一并清掉——不属于本次 interrupt 的后续轮次会按
          // 默认（清空 queue）行为走，避免 stale flag 影响下一次普通 interrupt。
          // 注意：被保留的 queuedMessages 不需要在这里主动 flush，重发的
          // interruptPrompt 跑完会自然触发 flushNextQueuedMessage。
          this.preserveQueueOnInterrupt.delete(sessionId);
          settled = true;
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] codex interrupt-and-send failed:", err);
            });
          });
          return;
        }
        settled = true;
        resolve();
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      });
    });
  }

  private runOpenCodeStreaming(sessionId: string, session: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = buildOpenCodeArgs(session);
      const spawnedAt = new Date().toISOString();
      const child = spawn("opencode", args, {
        cwd: session.cwd,
        env: buildChildEnv(this.config.inheritEnv !== false),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.logger?.appendStructuredSpawn(sessionId, {
        kind: "opencode-run",
        provider: "opencode",
        pid: child.pid ?? null,
        cwd: session.cwd,
        args,
        prompt: prompt.slice(0, 2048),
        promptLength: prompt.length,
        sessionId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(prompt);

      const turnState: StreamingTurnState = {
        blocks: [],
        result: "",
        sessionId: session.claudeSessionId,
        model: session.selectedModel ?? session.structuredState?.model,
        usage: undefined,
        codexBlockIndex: new Map(),
        cwd: session.cwd,
      };
      let lineBuf = "";
      let stderr = "";
      let primaryError: string | null = null;
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const syncSnapshot = (): void => {
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) return;
        const turn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        const messages = [...(current.messages ?? [])];
        if (messages[messages.length - 1]?.role === "assistant") messages[messages.length - 1] = turn;
        else messages.push(turn);
        const patched: SessionSnapshot = {
          ...current,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages,
          output: turnState.result || current.output,
        };
        this.sessions.set(sessionId, patched);
        this.saveStreamingSnapshot(patched);
      };
      const flushEmit = (): void => {
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        emitTimer = null;
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (current) this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
      };
      const scheduleEmit = (): void => {
        if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
      };
      const processLine = (line: string): void => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
        this.logger?.appendStreamEvent(sessionId, event);
        const error = applyOpenCodeEvent(turnState, event);
        if (error) primaryError = error;
        syncSnapshot();
        scheduleEmit();
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });
      child.on("error", (error) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          settled = true;
          resolve();
          return;
        }
        settled = true;
        const nodeError = error as NodeJS.ErrnoException;
        const hint = nodeError.code === "ENOENT"
          ? "（PATH 中找不到 opencode；请安装 opencode-ai，或重跑 `wand service:install` 刷新服务 PATH）"
          : "";
        reject(new Error(`opencode run 启动失败：${error.message}${hint}`));
      });
      child.on("close", (code, signal) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          if (emitTimer) this.clearStreamEmitTimer(emitTimer);
          settled = true;
          resolve();
          return;
        }
        if (lineBuf.trim()) processLine(lineBuf);
        flushEmit();
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) {
          settled = true;
          resolve();
          return;
        }
        const interruptedByUser = this.interruptedWith.has(sessionId);
        const interruptPrompt = this.interruptedWith.get(sessionId);
        if ((primaryError || (code !== 0 && code !== null) || signal) && !interruptedByUser) {
          const legacyHint = /unknown command|unknown flag|No help topic for 'run'/i.test(stderr)
            ? "\n检测到旧版 OpenCode CLI；请卸载 0.0.x 旧包并安装 `opencode-ai@latest`。"
            : "";
          const errorText = this.formatStructuredExitError("opencode run", code, signal, { stderr, primary: primaryError }) + legacyHint;
          const failed = this.finishStructuredFailure(current, typeof code === "number" ? code : 1, errorText, turnState);
          this.sessions.set(sessionId, failed);
          this.saveAuthoritativeSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          settled = true;
          reject(new PersistedStructuredRunnerError(errorText));
          return;
        }
        const messages = this.buildCompletedAssistantMessages(current, turnState);
        const keepRunning = !!interruptPrompt;
        const finished: SessionSnapshot = {
          ...current,
          status: keepRunning ? "running" : "idle",
          exitCode: keepRunning ? null : 0,
          endedAt: keepRunning ? null : new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages,
          queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
          pendingEscalation: null,
          permissionBlocked: false,
          structuredState: {
            ...(current.structuredState as StructuredSessionState),
            model: turnState.model ?? current.structuredState?.model,
            inFlight: false,
            activeRequestId: null,
            lastError: null,
          },
        };
        this.sessions.set(sessionId, finished);
        this.saveAuthoritativeSession(finished);
        this.emitStructuredSnapshot(finished);
        if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          this.preserveQueueOnInterrupt.delete(sessionId);
          settled = true;
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((error) => {
              console.error("[WAND] opencode interrupt-and-send failed:", error);
            });
          });
          return;
        }
        settled = true;
        resolve();
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Streaming claude -p execution
  // ---------------------------------------------------------------------------

  /**
   * Spawn `claude -p --output-format stream-json` and parse NDJSON lines as
   * they arrive, emitting incremental WebSocket events so the UI can render
   * text / thinking / tool_use blocks in real-time.
   *
   * Permission handling:
   * - Non-root + full-access/managed: --permission-mode bypassPermissions
   * - Non-root + auto-edit: --permission-mode acceptEdits
   * - Root: --permission-mode acceptEdits + --allowedTools (extends approval
   *   outside CWD). stdin is always "ignore" — no ACP bidirectional control.
   */
  private runClaudeStreaming(sessionId: string, session: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const permPolicy = derivePermissionPolicy(session.mode, session.autoApprovePermissions ?? false, session.cwd);
      const isManaged = session.mode === "managed";
      const args = buildClaudeCliArgs(session, {
        permissionPolicy: permPolicy,
        systemPromptParts: buildAppendSystemPromptParts(this.config.language, session.mode),
      });

      // 通过 stdin 传 prompt，避免被 --allowedTools / --disallowedTools 这类
      // variadic 参数贪婪吞掉（commander 的 <tools...> 会一直吃 positional 直到
      // 下一个 flag）。表现为 claude 报 "Input must be provided either through
      // stdin or as a prompt argument when using --print"。
      //
      // 思考深度通过 --effort 传给 Claude CLI；prompt 保持用户原文。
      const spawnedAt = new Date().toISOString();
      const child = spawn("claude", args, {
        cwd: session.cwd,
        env: buildChildEnv(this.config.inheritEnv !== false),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.logger?.appendStructuredSpawn(sessionId, {
        kind: "claude-print",
        provider: "claude",
        pid: child.pid ?? null,
        cwd: session.cwd,
        args,
        prompt: prompt.slice(0, 2048),
        promptLength: prompt.length,
        claudeSessionId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(prompt);

      const turnState: StreamingTurnState = {
        blocks: [],
        result: "",
        sessionId: null,
        model: undefined,
        usage: undefined,
      };

      // claude -p --output-format stream-json 在同一条消息流式生成期间会重复
      // emit 同一个 message.id 的 "assistant" 事件，每次 content 略多一些；子
      // agent 流（Task 工具）则会插入若干 parent_tool_use_id 不同的 message.id。
      // 朴素的 push(...content) 会让早期片段被反复合并复制，最终被 compact 出
      // 怪异结果，导致 UI 上 tool_use / 子 agent 输出"显示一下就消失"。
      // 这里按 (message.id) 去重，相同 id 视作同一消息的更新覆盖；tool_result
      // 用单调递增的合成 key 顺序追加。每次事件后用插入顺序重建 turnState.blocks。
      const blocksByKey = new Map<string, ContentBlock[]>();
      const keyOrder: string[] = [];
      let toolResultSeq = 0;
      // 本轮 Task tool_use_id → meta map，由父 assistant 消息里的 Task tool_use
      // 填充；子 agent message（parent_tool_use_id 非空）来时用它给每个 block 盖章。
      const taskMetaRegistry: TaskMetaMap = new Map();
      // 估算单个 ContentBlock 的"信息体积"——文字 / thinking / tool input 长度之和。
      // 用于 upsertBlocks 的防御性合并：同一 message.id 重发时，按位置取信息量更大的
      // 那个版本，保证已经吐出的文字 / tool_use input 不会被一条更短的同 id 事件
      // 整段覆盖。
      const blockVolume = (b: ContentBlock | undefined): number => {
        if (!b) return 0;
        const anyB = b as any;
        let total = 0;
        if (typeof anyB.text === "string") total += anyB.text.length;
        if (typeof anyB.thinking === "string") total += anyB.thinking.length;
        if (typeof anyB.content === "string") total += anyB.content.length;
        if (anyB.input) {
          try { total += JSON.stringify(anyB.input).length; } catch (_e) { /* ignore */ }
        }
        return total;
      };
      const upsertBlocks = (key: string, blocks: ContentBlock[]): void => {
        const prev = blocksByKey.get(key);
        if (!prev) {
          keyOrder.push(key);
          blocksByKey.set(key, blocks);
          return;
        }
        // claude -p 在同一 message.id 的多次 assistant 事件有两种观察到的协议：
        //   a) **累积模式**：每次 event 的 content = 之前所有 blocks + 0~N 新 block，
        //      同位置类型一致。流式 text/thinking 的逐字增量属于这种。
        //   b) **拼接模式**：SDK 把 thinking 和后续的 tool_use 拆成两条 event 给同
        //      一 msg.id 发出，第二条只带 tool_use，**不包含**之前的 thinking。
        //      Opus 4.7 + claude-agent-sdk 实际跑下来就是这种。
        //
        // 老逻辑（"同 index 类型不一致 → 保留 prev"）只对 a) 友好，碰上 b) 会让第
        // 二条事件里的 tool_use 直接被丢掉——表现是 Agent / Read 等 tool_use 永远
        // 不出现在 messages 里，subagent 多角色无法关联 agentType 到父 Task。
        //
        // 先判定 incoming 是不是 prev 的"累积超集"（mode a）：长度不短于 prev，
        // 且前 prev.length 个 block 类型逐位一致。是 → 走逐位取大 + 末尾追加。
        let cumulative = blocks.length >= prev.length;
        if (cumulative) {
          for (let i = 0; i < prev.length; i++) {
            const a = prev[i];
            const b = blocks[i];
            if (a && b && a.type !== b.type) { cumulative = false; break; }
          }
        }

        if (cumulative) {
          const merged: ContentBlock[] = [];
          const appendix: ContentBlock[] = [];
          for (let i = 0; i < blocks.length; i++) {
            const a = prev[i];
            const b = blocks[i];
            if (a && !b) { merged.push(a); continue; }
            if (!a && b) { merged.push(b); continue; }
            if (a && b) {
              if (a.type === b.type) {
                // 同类型：取信息量大者，避免短回退覆盖已经累积的内容。
                merged.push(blockVolume(b) >= blockVolume(a) ? b : a);
              } else {
                // 类型变了：保留 prev[i]，把 incoming block 追加到末尾。
                merged.push(a);
                appendix.push(b);
              }
            }
          }
          for (const b of appendix) merged.push(b);
          blocksByKey.set(key, merged);
          return;
        }

        // mode b（拼接/splice）：incoming 不是累积超集——SDK 把同一 msg.id 的
        // thinking / text / 多个 tool_use 拆成一条条「只带新 block」的事件发出
        // （新版 claude 连发 4 个 TaskCreate 就是这样）。老逻辑 `blocks.length <
        // prev.length 直接 return` 会把这些单 block 事件整段丢弃，导致 TaskCreate /
        // Agent / Read 等永远进不了 messages。这里保留 prev 全部，按 block 身份
        // 增量合并：tool_use 用 id 去重（已存在则取信息量大的就地更新，否则追加）；
        // text / thinking 仅在没有完全相同内容时追加，挡住「短回退」的重复 frame。
        const merged: ContentBlock[] = [...prev];
        const idIndex = new Map<string, number>();
        merged.forEach((b, i) => {
          const anyB = b as any;
          if (b.type === "tool_use" && typeof anyB.id === "string") idIndex.set(anyB.id, i);
        });
        for (const b of blocks) {
          const anyB = b as any;
          if (b.type === "tool_use" && typeof anyB.id === "string") {
            const at = idIndex.get(anyB.id);
            if (at !== undefined) {
              if (blockVolume(b) >= blockVolume(merged[at])) merged[at] = b;
            } else {
              idIndex.set(anyB.id, merged.length);
              merged.push(b);
            }
            continue;
          }
          if (b.type === "tool_result") { merged.push(b); continue; }
          // text / thinking：同类型且文本完全一致视为重复回退，跳过。
          const dup = merged.some((x) => x.type === b.type
            && (x as any).text === anyB.text
            && (x as any).thinking === anyB.thinking);
          if (!dup) merged.push(b);
        }
        blocksByKey.set(key, merged);
      };
      const rebuildTurnBlocks = (): void => {
        const flat: ContentBlock[] = [];
        for (const key of keyOrder) {
          const entry = blocksByKey.get(key);
          if (entry && entry.length > 0) flat.push(...entry);
        }
        turnState.blocks = flat;
      };

      // Line buffer for NDJSON: chunks from stdout may split mid-line.
      let lineBuf = "";

      // Debounce output events to avoid flooding the WebSocket.
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      // 当 Claude 在非托管模式调用 AskUserQuestion 时，stdin 关闭导致它会 hang 等
      // tool_result。我们检测到后主动 kill child，让它顺利退出，UI 把 tool_use 卡片
      // 渲染成可交互选项；用户提交后由 sendMessage() 通过 --resume 续接。
      let killedForAskUserQuestion = false;

      const flushEmit = (): void => {
        if (emitTimer) {
          this.clearStreamEmitTimer(emitTimer);
          emitTimer = null;
        }
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) return;
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) {
          emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
        }
      };

      /** Update the session snapshot with the current in-progress assistant turn. */
      const syncSnapshot = (): void => {
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) return;
        const inProgressTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        // Replace or append the in-progress assistant turn at the end of messages.
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = inProgressTurn;
        } else {
          msgs.push(inProgressTurn);
        }
        const patched: SessionSnapshot = {
          ...current,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          output: turnState.result || current.output,
          structuredState: {
            ...(current.structuredState as StructuredSessionState),
            model: turnState.model ?? current.structuredState?.model,
          },
        };
        this.sessions.set(sessionId, patched);
        // Persist streaming progress so a server restart does not roll back the
        // latest assistant turn to the pre-stream snapshot. Throttled because
        // saveSession serializes the full messages array.
        this.saveStreamingSnapshot(patched);
      };

      // 关键修复：claude -p 的 session_id 出现在 system(init) / assistant / user /
      // result 全部事件里，并非只在最终的 result。若本轮被中断（用户打断、
      // AskUserQuestion 主动 kill、ExitPlanMode 自续接）或进程异常退出而没走到
      // result，旧逻辑只在 result 里取 session_id 会让 claudeSessionId 一直为 null，
      // 下一轮（含排队消息续接）就不带 --resume → 丢掉全部历史上下文。这里从任何带
      // session_id 的事件即时捕获并落库，保证 resume 链不因缺少 result 事件而断裂。
      const captureSessionId = (sid: unknown): void => {
        if (typeof sid !== "string" || !sid) return;
        if (turnState.sessionId === sid) return;
        turnState.sessionId = sid;
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (current && current.claudeSessionId !== sid) {
          const patched: SessionSnapshot = { ...current, claudeSessionId: sid };
          this.sessions.set(sessionId, patched);
          this.saveStreamingSnapshot(patched, { metadata: true });
        }
      };

      const processLine = (line: string): void => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        this.logger?.appendStreamEvent(sessionId, parsed);
        // 所有事件都可能带顶层 session_id（含 system init）；立即捕获，不等 result。
        captureSessionId(parsed?.session_id);

        if (parsed && parsed.type === "assistant" && parsed.message) {
          const extracted = this.extractAssistantMessage(parsed.message);
          // 用 message.id 作为 key：claude -p 流式重发同一条消息时整段覆盖
          // （而不是与早期片段累加），子 agent 的不同消息 id 各占一格、保留
          // 父子完整顺序。没有 id 时退化为合成 key 走追加模式。
          const msgId = typeof parsed.message.id === "string" && parsed.message.id
            ? `assistant:${parsed.message.id}`
            : `assistant:anon:${keyOrder.length}`;
          // parent_tool_use_id 决定父/子 agent。父 message 里的 Task tool_use 登记
          // 到 taskMetaRegistry；子 message 的每个 block 用 __subagent 盖章。
          const parentToolUseId = typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id
            ? parsed.parent_tool_use_id
            : null;
          if (parentToolUseId === null) {
            captureTaskMeta(extracted.content, taskMetaRegistry);
          }
          const stamped = parentToolUseId === null
            ? stampSelfTask(extracted.content, taskMetaRegistry)
            : tagSubagentBlocks(extracted.content, parentToolUseId, taskMetaRegistry);
          if (stamped.length > 0) {
            upsertBlocks(msgId, stamped);
            rebuildTurnBlocks();
          }
          // NOTE: usage from streaming "assistant" events contains partial/incremental
          // token counts (e.g. output_tokens=1 during streaming) and is NOT accurate.
          // We only use the authoritative usage from the final "result" event.
          syncSnapshot();
          scheduleEmit();

          // 非托管模式下检测 AskUserQuestion：claude -p 的 stdin 被 ignore，无法回传
          // tool_result，进程会 hang 住。主动 SIGTERM 让它退出；后续用户提交答案时由
          // sendMessage() 注入伪造的 tool_result 并通过 --resume 续接。
          if (!isManaged && !killedForAskUserQuestion) {
            const askBlock = extracted.content.find(
              (b): b is ContentBlock & { type: "tool_use" } =>
                b.type === "tool_use" && b.name === "AskUserQuestion",
            );
            if (askBlock) {
              killedForAskUserQuestion = true;
              flushEmit();
              try { child.kill("SIGTERM"); } catch (_err) { /* ignore */ }
            }
          }
          return;
        }

        if (parsed && parsed.type === "user" && parsed.message && Array.isArray(parsed.message.content)) {
          // tool_result 没有自身 id，按到达顺序用合成 key 追加（永远不被覆盖）。
          const collected: ContentBlock[] = [];
          for (const block of parsed.message.content) {
            if (block && block.type === "tool_result") {
              collected.push({
                type: "tool_result",
                tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
                content: this.normalizeToolResultContent(block.content),
                is_error: block.is_error === true,
              });
            }
          }
          const parentToolUseId = typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id
            ? parsed.parent_tool_use_id
            : null;
          const stamped = parentToolUseId === null
            ? stampParentTaskResults(collected, taskMetaRegistry)
            : tagSubagentBlocks(collected, parentToolUseId, taskMetaRegistry);
          if (stamped.length > 0) {
            upsertBlocks(`tool_result:${toolResultSeq++}`, stamped);
            rebuildTurnBlocks();
          }
          syncSnapshot();
          scheduleEmit();
          return;
        }

        if (parsed && parsed.type === "result") {
          if (typeof parsed.result === "string") {
            turnState.result = parsed.result.trim();
          }
          // session_id 已由顶部 captureSessionId 统一捕获，这里不再重复赋值。
          turnState.model = this.extractModelName(parsed.modelUsage) ?? turnState.model;
          turnState.usage = this.extractUsage(parsed) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
        }
      };

      let stderr = "";
      // 兜底：当 stderr 是空、JSON 也没解析到任何错误事件时，把最后一段非空
      // stdout 文本作为上下文塞给错误信息。claude -p 偶尔会把 fatal error 以
      // 纯文本（非 JSON）打到 stdout 然后非零退出，之前的实现会丢掉这部分。
      let lastRawStdoutChunk = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        const trimmed = text.trim();
        if (trimmed) lastRawStdoutChunk = trimmed.slice(-1024);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        // Keep the last (possibly incomplete) segment in the buffer.
        lineBuf = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          settled = true;
          resolve();
          return;
        }
        settled = true;
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-print-error",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          spawnError: error.message,
        });
        // 同 codex 那边：spawn ENOENT 最常见，提示用户去 service:install 刷 PATH。
        const nodeErr = error as NodeJS.ErrnoException;
        const hint = nodeErr.code === "ENOENT"
          ? "（PATH 中找不到 claude 可执行文件；请确认 claude 已安装，或重跑 `wand service:install` 刷新服务的 PATH）"
          : "";
        reject(new Error(`claude -p 启动失败：${error.message}${hint}`));
      });

      child.on("close", (code, signal) => {
        const released = this.releasePendingChild(sessionId, child);
        if (released) this.cancelStreamingCheckpointTimer(sessionId);
        if (settled) return;
        if (!this.isCurrentRequest(sessionId, requestId)) {
          if (emitTimer) this.clearStreamEmitTimer(emitTimer);
          settled = true;
          resolve();
          return;
        }
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-print-close",
          pid: child.pid ?? null,
          spawnedAt,
          closedAt: new Date().toISOString(),
          exitCode: code,
          stderrTail: stderr.slice(-2048),
        });

        // Process any remaining data in the line buffer.
        if (lineBuf.trim()) {
          processLine(lineBuf);
          lineBuf = "";
        }

        // Flush any pending debounced emit before finalizing.
        flushEmit();

        // Finalize the session snapshot.
        const current = this.currentSessionForRequest(sessionId, requestId);
        if (!current) {
          settled = true;
          resolve();
          return;
        }

        // 如果是用户主动中断（interruptedWith 里有新消息），claude -p 收到 SIGTERM 后
        // 可能以非零 exit code 退出（内部 handler 调了 exit(1)）。这种情况属于正常
        // 中断流程，不应走失败路径——后续 interruptedWith 逻辑会发送新消息。
        const interruptedByUser = this.interruptedWith.has(sessionId);
        const failedExit = (code !== null && code !== 0) || signal !== null;
        if (failedExit && !interruptedByUser && !killedForAskUserQuestion) {
          const errorText = this.formatStructuredExitError("claude -p", code, signal, {
            stderr,
            // claude -p 没有 codex 那种独立的 turn.failed 事件，所以 primary 留空；
            // 退路是 stderr / stdoutTail。
            stdoutTail: lastRawStdoutChunk,
          });
          const failureTurn: ConversationTurn = {
            role: "assistant",
            content: [{ type: "text", text: `结构化会话执行失败：${errorText}` }],
          };
          const msgs = [...(current.messages ?? [])];
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            msgs[msgs.length - 1] = failureTurn;
          } else {
            msgs.push(failureTurn);
          }
          // 仅 signal 终止时 code 为 null；用 1 占位，让 UI 的"exitCode !== 0"判定也能命中。
          const exitForSnapshot = typeof code === "number" ? code : 1;
          const failed: SessionSnapshot = {
            ...current,
            status: "failed",
            exitCode: exitForSnapshot,
            endedAt: new Date().toISOString(),
            output: errorText,
            claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
            messages: msgs,
            pendingEscalation: null,
            permissionBlocked: false,
            structuredState: {
              ...(current.structuredState as StructuredSessionState),
              model: turnState.model ?? current.structuredState?.model,
              inFlight: false,
              activeRequestId: null,
              lastError: errorText,
            },
          };
          this.sessions.set(sessionId, failed);
          this.saveAuthoritativeSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          settled = true;
          reject(new PersistedStructuredRunnerError(errorText));
          return;
        }

        const msgs = this.buildCompletedAssistantMessages(current, turnState);

        // 被 AskUserQuestion 检测或用户中断主动 kill 时，保持 status="running"
        // 让 UI 不跳到"已停止"。inFlight=false 才能触发后续 sendMessage。
        const interruptPrompt = this.interruptedWith.get(sessionId);
        const keepRunning = killedForAskUserQuestion || !!interruptPrompt;
        const finished: SessionSnapshot = {
          ...current,
          status: keepRunning ? "running" : "idle",
          exitCode: keepRunning ? null : 0,
          endedAt: keepRunning ? null : new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
          pendingEscalation: null,
          permissionBlocked: false,
          structuredState: {
            ...(current.structuredState as StructuredSessionState),
            model: turnState.model ?? current.structuredState?.model,
            inFlight: false,
            activeRequestId: null,
            lastError: null,
          },
        };
        this.sessions.set(sessionId, finished);
        this.saveAuthoritativeSession(finished);

        this.emitStructuredSnapshot(finished);
        if (!keepRunning) {
          this.emitStructuredSnapshot(finished, "ended");
        }

        // 用户中断当前回复：保存部分回复后立即发送新消息。
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          // 把"保留队列"标记一并清掉——不属于本次 interrupt 的后续轮次会按
          // 默认（清空 queue）行为走，避免 stale flag 影响下一次普通 interrupt。
          // 注意：被保留的 queuedMessages 不需要在这里主动 flush，重发的
          // interruptPrompt 跑完会自然触发 flushNextQueuedMessage。
          this.preserveQueueOnInterrupt.delete(sessionId);
          settled = true;
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] interrupt-and-send failed:", err);
            });
          });
          return;
        }

        if (killedForAskUserQuestion) {
          settled = true;
          resolve();
          // An answer can arrive after AskUserQuestion triggered SIGTERM but
          // before close finalized the turn. It was queued while inFlight; now
          // advance it normally so it becomes the matching tool_result.
          if ((finished.queuedMessages?.length ?? 0) > 0) {
            setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
          }
          return;
        }

        // Auto-continue after plan mode exit: when Claude calls ExitPlanMode,
        // the `-p` process exits because stdin is "ignore" and it cannot get
        // user confirmation.  Detect this and automatically resume execution
        // so the plan is actually carried out.
        const lastToolUse = [...turnState.blocks].reverse().find(
          (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
        );
        if (lastToolUse && lastToolUse.name === "ExitPlanMode" && turnState.sessionId) {
          settled = true;
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((err) => {
              console.error("[WAND] Auto-continue after ExitPlanMode failed:", err);
            });
          });
          return;
        }

        settled = true;
        resolve();
        setImmediate(() => {
          void this.flushNextQueuedMessage(sessionId);
        });
      });    });
  }

  // ---------------------------------------------------------------------------
  // Streaming claude-agent-sdk execution
  // ---------------------------------------------------------------------------

  /**
   * Use @anthropic-ai/claude-agent-sdk instead of spawning claude -p directly.
   * The SDK still spawns the claude binary but provides typed AsyncGenerator<SDKMessage>
   * messages, so we skip NDJSON parsing. Options are 1:1 with the CLI flags.
   *
   * Streaming is enabled via includePartialMessages: true — the SDK emits
   * SDKPartialAssistantMessage (type: "stream_event") with BetaRawMessageStreamEvent
   * payloads for incremental text/thinking/tool_use updates, followed by a final
   * SDKAssistantMessage with the authoritative complete content.
   */
  private async runClaudeSdkStreaming(sessionId: string, session: SessionSnapshot, prompt: string, requestId: string): Promise<void> {
    const abortController = new AbortController();
    this.pendingSdkAbort.set(sessionId, abortController);

    const isManaged = session.mode === "managed";
    let killedForAskUserQuestion = false;

    // 权限策略 + 系统提示词都通过共享 helper 派生，与 CLI runner 一字不差。
    const permPolicy = derivePermissionPolicy(session.mode, session.autoApprovePermissions ?? false, session.cwd);
    const systemPromptParts = buildAppendSystemPromptParts(this.config.language, session.mode);

    const sdkClaudeBinary = resolveSdkClaudeBinary();
    // SDK 默认会把整个 process.env 透传给 claude 子进程；这里显式按 inheritEnv 配置组装，
    // 否则关闭"继承环境变量"开关时 SDK 路径会被静默忽略。
    const sdkEnv = buildChildEnv(this.config.inheritEnv !== false);
    const sdkThinking = buildClaudeSdkThinking(session.thinkingEffort);

    const sdkOptions: SdkOptions = {
      cwd: session.cwd,
      abortController,
      env: sdkEnv as Record<string, string | undefined>,
      permissionMode: permPolicy.permissionMode,
      ...(permPolicy.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(permPolicy.allowedTools ? { allowedTools: permPolicy.allowedTools } : {}),
      ...(isManaged ? { disallowedTools: ["AskUserQuestion"] } : {}),
      thinking: sdkThinking,
      includePartialMessages: true,
      // 把子 agent 的 text/thinking 也转发回来，UI 才能把"被 Task 召唤来的协作者"
      // 渲染成独立角色的群聊消息。关掉这个开关时只会收到子 agent 的 tool_use/tool_result，
      // text/thinking 被 SDK 吞掉。
      forwardSubagentText: true,
      ...(systemPromptParts.length > 0 ? { appendSystemPrompt: systemPromptParts.join("\n\n") } : {}),
      ...(sdkClaudeBinary ? { pathToClaudeCodeExecutable: sdkClaudeBinary } : {}),
    };

    if (session.claudeSessionId) sdkOptions.resume = session.claudeSessionId;

    const modelChoice = session.selectedModel?.trim();
    if (modelChoice && modelChoice !== "default") sdkOptions.model = modelChoice;

    // Streaming input mode：把这一轮的 user turn 重建成一条 SDKUserMessage 喂给 SDK。
    // 上层 sendMessage 已经把 userTurn 写进 session.messages 末尾——如果它的内容是
    // tool_result，说明本次是用户在回答上一轮 AskUserQuestion，否则就是普通文本。
    // 走 streaming input 而非 string prompt 的好处：tool_result 是真的 tool_result
    // block，对 Claude 来说就是标准工具回传，不需要 "[对刚才工具的回答…]" 这种文本
    // 提示让模型脑补语义。
    const lastUserTurn = (session.messages ?? []).slice().reverse().find((m) => m.role === "user");
    const lastUserBlock = lastUserTurn?.content?.[0];

    let sdkInitialMessage: SDKUserMessage;
    if (lastUserBlock?.type === "tool_result") {
      // Anthropic 的 tool_result.content 原生支持 string 或 content-block 数组（text/image
      // 等）。wand 内部 ToolResultBlock 的 array 形态是 `{type: string; ...}` 比官方 union
      // 宽，但实际取值都是 `{type: "text", text}`，结构上兼容；用 `as` 把宽类型缩到 SDK
      // 接受的形态即可，比 JSON.stringify 把数组拍成一坨 JSON 文本更忠实。
      sdkInitialMessage = {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: lastUserBlock.tool_use_id,
              content: lastUserBlock.content as string | Array<{ type: "text"; text: string }>,
              is_error: lastUserBlock.is_error === true,
            },
          ],
        },
        parent_tool_use_id: null,
      };
    } else {
      sdkInitialMessage = {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
        parent_tool_use_id: null,
      };
    }

    async function* singleShotPrompt(): AsyncGenerator<SDKUserMessage> {
      yield sdkInitialMessage;
    }

    const turnState: StreamingTurnState = {
      blocks: [],
      result: "",
      sessionId: null,
      model: undefined,
      usage: undefined,
    };

    // Tracks in-progress streaming blocks keyed by content_block index from stream_event.
    // The map is cleared whenever a complete `assistant` message arrives — its blocks
    // are then promoted into `finalizedBlocks` below.
    //
    // `parentToolUseId` carries through from SDKPartialAssistantMessage so we can
    // stamp streaming blocks with subagent persona *during* streaming, not only
    // after the completion event. Without it, subagent text shows up under the
    // parent's avatar for tens of ms then snaps to the subagent — visible flicker.
    const streamingBlockByIndex = new Map<number, {
      type: "text" | "thinking" | "tool_use";
      id?: string;
      name?: string;
      text: string;
      thinking: string;
      partialInput: string;
      finalized: boolean;
      parentToolUseId: string | null;
    }>();

    // Blocks from messages that have already completed within this turn — including
    // the parent assistant's prior messages, every subagent assistant message, and
    // every tool_result. Subagent (Task tool) flows produce many assistant messages
    // back-to-back; without this list, each new streaming message would visually
    // erase everything that came before it in the same turn.
    const finalizedBlocks: ContentBlock[] = [];

    // Per-turn Task tool_use_id → meta map; populated from the parent assistant's
    // Task tool_use blocks and consulted when subagent messages arrive.
    const taskMetaRegistry: TaskMetaMap = new Map();

    let emitTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEmit = (): void => {
      if (emitTimer) { this.clearStreamEmitTimer(emitTimer); emitTimer = null; }
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
    };

    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = this.trackStreamEmitTimer(setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS));
    };

    // Rebuild ContentBlock[] from finalized history + the in-progress streaming map.
    // Returning only the streaming blocks would drop every prior parent/subagent
    // message in this turn (the original disappearing-output bug).
    const rebuildStreamingBlocks = (): ContentBlock[] => {
      const sorted = [...streamingBlockByIndex.entries()].sort((a, b) => a[0] - b[0]);
      const streaming: ContentBlock[] = [];
      for (const [, sb] of sorted) {
        let block: ContentBlock | null = null;
        if (sb.type === "text") {
          block = { type: "text", text: sb.text };
        } else if (sb.type === "thinking") {
          block = { type: "thinking", thinking: sb.thinking };
        } else if (sb.type === "tool_use" && sb.id && sb.name) {
          let input: Record<string, unknown> = {};
          if (sb.finalized && sb.partialInput) {
            try { input = JSON.parse(sb.partialInput) as Record<string, unknown>; } catch { /* partial json */ }
          }
          block = { type: "tool_use", id: sb.id, name: sb.name, input: this.normalizeToolInput(sb.name, input) };
        }
        if (!block) continue;
        if (sb.parentToolUseId) {
          const [stamped] = tagSubagentBlocks([block], sb.parentToolUseId, taskMetaRegistry);
          streaming.push(stamped);
        } else {
          streaming.push(block);
        }
      }
      // 流式阶段就给 Task/Agent tool_use 本身盖章，防止"先显示工具卡片几秒再跳为
      // handoff 行"的闪烁。content_block_start 阶段就有 name=Task/Agent，
      // stampSelfTask 据此即可命中；agentType 字段藏在 input 里，delta 累计后再由
      // 后续 captureTaskMeta 回填 registry，下次 rebuild 自动补上更完整的 stamp。
      captureTaskMeta(streaming, taskMetaRegistry);
      const stampedStreaming = stampSelfTask(streaming, taskMetaRegistry);
      return [...finalizedBlocks, ...stampedStreaming];
    };

    const syncSnapshot = (): void => {
      const current = this.currentSessionForRequest(sessionId, requestId);
      if (!current) return;
      const inProgressTurn: ConversationTurn = {
        role: "assistant",
        content: this.compactContentBlocks([...turnState.blocks], turnState.result),
        usage: turnState.usage,
      };
      const msgs = [...(current.messages ?? [])];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = inProgressTurn;
      else msgs.push(inProgressTurn);
      const patched: SessionSnapshot = {
        ...current,
        claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
        messages: msgs,
        output: turnState.result || current.output,
        structuredState: {
          ...(current.structuredState as StructuredSessionState),
          model: turnState.model ?? current.structuredState?.model,
        },
      };
      this.sessions.set(sessionId, patched);
      this.saveStreamingSnapshot(patched);
    };

    const spawnedAt = new Date().toISOString();
    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk",
      provider: "claude",
      cwd: session.cwd,
      permissionMode: permPolicy.permissionMode,
      prompt: prompt.slice(0, 2048),
      promptLength: prompt.length,
      claudeSessionId: session.claudeSessionId,
      spawnedAt,
    });

    let queryHandle: ReturnType<typeof sdkQuery>;
    try {
      queryHandle = this.sdkQueryFactory({ prompt: singleShotPrompt(), options: sdkOptions });
    } catch (error) {
      this.releasePendingSdkAbort(sessionId, abortController);
      throw error;
    }
    this.pendingSdkQueries.set(sessionId, queryHandle);

    try {
      for await (const msg of queryHandle as AsyncIterable<SDKMessage>) {
        if (abortController.signal.aborted || !this.isCurrentRequest(sessionId, requestId)) break;

        // 同 CLI runner 的关键修复：从任何带 session_id 的 SDK 消息（system / assistant /
        // user / result）即时捕获并落库。AskUserQuestion 的 interrupt 发生在 assistant
        // 之后、result 之前，若只在 result 捕获，被 interrupt 的轮次会丢掉 session_id，
        // 续接时不 resume → 上下文丢失。stream_event 等无 session_id 的消息被 guard 跳过。
        const msgSessionId = (msg as { session_id?: unknown }).session_id;
        if (typeof msgSessionId === "string" && msgSessionId && turnState.sessionId !== msgSessionId) {
          turnState.sessionId = msgSessionId;
          const cur = this.currentSessionForRequest(sessionId, requestId);
          if (cur && cur.claudeSessionId !== msgSessionId) {
            const patched: SessionSnapshot = { ...cur, claudeSessionId: msgSessionId };
            this.sessions.set(sessionId, patched);
            this.saveStreamingSnapshot(patched, { metadata: true });
          }
        }

        // Incremental streaming events (opt-in via includePartialMessages: true)
        if (msg.type === "stream_event") {
          const partial = msg as unknown as {
            type: "stream_event";
            event: Record<string, unknown>;
            parent_tool_use_id?: string | null;
          };
          const ev = partial.event;
          const partialParentId = partial.parent_tool_use_id ?? null;
          if (ev.type === "content_block_start") {
            const cb = ev.content_block as Record<string, unknown>;
            const blockType = cb.type as string;
            if (blockType === "text" || blockType === "thinking" || blockType === "tool_use") {
              streamingBlockByIndex.set(ev.index as number, {
                type: blockType as "text" | "thinking" | "tool_use",
                id: typeof cb.id === "string" ? cb.id : undefined,
                name: typeof cb.name === "string" ? cb.name : undefined,
                text: typeof cb.text === "string" ? cb.text : "",
                thinking: typeof cb.thinking === "string" ? cb.thinking : "",
                partialInput: "",
                finalized: false,
                parentToolUseId: partialParentId,
              });
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          } else if (ev.type === "content_block_delta") {
            const sb = streamingBlockByIndex.get(ev.index as number);
            if (sb) {
              const delta = ev.delta as Record<string, unknown>;
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                sb.text += delta.text;
                turnState.result = sb.text;
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                sb.thinking += delta.thinking;
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                sb.partialInput += delta.partial_json;
              }
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          } else if (ev.type === "content_block_stop") {
            const sb = streamingBlockByIndex.get(ev.index as number);
            if (sb) {
              sb.finalized = true;
              turnState.blocks = rebuildStreamingBlocks();
              syncSnapshot();
              scheduleEmit();
            }
          }
          continue;
        }

        // Complete assistant turn — promote streaming content into the finalized
        // history so subsequent messages (subagents, follow-up parent messages)
        // append to it instead of erasing it.
        if (msg.type === "assistant") {
          const assistantMsg = msg as unknown as {
            type: "assistant";
            message: Record<string, unknown>;
            session_id: string;
            parent_tool_use_id?: string | null;
          };
          const extracted = this.extractAssistantMessage(assistantMsg.message);
          // 父 assistant 的 Task tool_use → 注册到本轮 taskMeta map；
          // 子 agent 的 message（parent_tool_use_id 非空）→ 给每个 block 盖章。
          const parentToolUseId = assistantMsg.parent_tool_use_id ?? null;
          if (parentToolUseId === null) {
            captureTaskMeta(extracted.content, taskMetaRegistry);
            finalizedBlocks.push(...stampSelfTask(extracted.content, taskMetaRegistry));
          } else {
            finalizedBlocks.push(...tagSubagentBlocks(extracted.content, parentToolUseId, taskMetaRegistry));
          }
          streamingBlockByIndex.clear();
          turnState.blocks = rebuildStreamingBlocks();
          if (assistantMsg.session_id) turnState.sessionId = assistantMsg.session_id;
          syncSnapshot();
          scheduleEmit();

          // Non-managed mode: detect AskUserQuestion. Prefer query.interrupt()
          // (streaming input mode 的 control message，让 SDK 优雅地停掉当前 turn）
          // 而不是 abortController.abort()——abort 会让 SDK throw AbortError，整段
          // try/catch 走异常路径；interrupt 让 for-await 自然结束，行为更干净。
          // 失败时 fallback 到 abort，保证一定能跳出。
          //
          // 注意：interrupt 之后下一次 sendMessage 会重新 spawn 一次 SDK 调用并通过
          // resume 续接 + tool_result block 回答，不用文本伪造。
          if (!isManaged && !killedForAskUserQuestion) {
            const askBlock = extracted.content.find(
              (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use" && b.name === "AskUserQuestion",
            );
            if (askBlock) {
              killedForAskUserQuestion = true;
              flushEmit();
              try {
                await queryHandle.interrupt();
              } catch (_err) {
                // interrupt 在某些情况下（已经结束 / SDK 版本不支持）会 reject，
                // 兜底用 abort 强制退出。
                abortController.abort();
              }
            }
          }
          continue;
        }

        // Tool results fed back from the claude subprocess (parent's view of a
        // tool call, or a subagent's tool_result during Task execution).
        if (msg.type === "user") {
          const userMsg = msg as unknown as {
            type: "user";
            message: Record<string, unknown>;
            parent_tool_use_id?: string | null;
          };
          const parentToolUseId = userMsg.parent_tool_use_id ?? null;
          const content = Array.isArray(userMsg.message?.content) ? userMsg.message.content as unknown[] : [];
          const collected: ContentBlock[] = [];
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b?.type === "tool_result") {
              collected.push({
                type: "tool_result",
                tool_use_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
                content: this.normalizeToolResultContent(b.content),
                is_error: b.is_error === true,
              });
            }
          }
          if (parentToolUseId === null) {
            finalizedBlocks.push(...stampParentTaskResults(collected, taskMetaRegistry));
          } else {
            finalizedBlocks.push(...tagSubagentBlocks(collected, parentToolUseId, taskMetaRegistry));
          }
          turnState.blocks = rebuildStreamingBlocks();
          syncSnapshot();
          scheduleEmit();
          continue;
        }

        // Final result — capture session_id, usage, model
        if (msg.type === "result") {
          const resultMsg = msg as Record<string, unknown>;
          if (typeof resultMsg.result === "string") turnState.result = resultMsg.result.trim();
          if (typeof resultMsg.session_id === "string") turnState.sessionId = resultMsg.session_id;
          turnState.model = this.extractModelName(resultMsg.modelUsage as Record<string, unknown> | undefined) ?? turnState.model;
          turnState.usage = this.extractSdkUsage(resultMsg);
          syncSnapshot();
          scheduleEmit();
          continue;
        }
      }
    } catch (err) {
      // AbortError from abortController.abort() is intentional — fall through to finish logic
      const isAbort = abortController.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (!isAbort) {
        const releasedAbort = this.releasePendingSdkAbort(sessionId, abortController);
        const releasedQuery = this.releasePendingSdkQuery(sessionId, queryHandle);
        if (releasedAbort || releasedQuery) this.cancelStreamingCheckpointTimer(sessionId);
        if (emitTimer) this.clearStreamEmitTimer(emitTimer);
        if (!this.isCurrentRequest(sessionId, requestId)) return;
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-sdk-error",
          spawnedAt,
          closedAt: new Date().toISOString(),
          error: getErrorMessage(err),
        });
        throw err;
      }
    }

    // Cleanup
    const releasedAbort = this.releasePendingSdkAbort(sessionId, abortController);
    const releasedQuery = this.releasePendingSdkQuery(sessionId, queryHandle);
    if (releasedAbort || releasedQuery) this.cancelStreamingCheckpointTimer(sessionId);
    if (emitTimer) this.clearStreamEmitTimer(emitTimer);
    if (!this.isCurrentRequest(sessionId, requestId)) return;
    flushEmit();

    const current = this.currentSessionForRequest(sessionId, requestId);
    if (!current) return;

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk-close",
      spawnedAt,
      closedAt: new Date().toISOString(),
      killedForAskUserQuestion,
      sessionId: turnState.sessionId,
    });

    const msgs = this.buildCompletedAssistantMessages(current, turnState);

    const interruptPrompt = this.interruptedWith.get(sessionId);
    const keepRunning = killedForAskUserQuestion || !!interruptPrompt;
    const finished: SessionSnapshot = {
      ...current,
      status: keepRunning ? "running" : "idle",
      exitCode: keepRunning ? null : 0,
      endedAt: keepRunning ? null : new Date().toISOString(),
      output: turnState.result,
      claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
      messages: msgs,
      queuedMessages: this.resolveQueuedMessagesAfterInterrupt(sessionId, current, interruptPrompt),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: null,
      },
    };
    this.sessions.set(sessionId, finished);
    this.saveAuthoritativeSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      // 与 codex/cli runner 对齐：清掉"保留队列"标记，避免 stale flag 影响下一次普通 interrupt。
      this.preserveQueueOnInterrupt.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((err) => {
          console.error("[WAND] sdk interrupt-and-send failed:", err);
        });
      });
      return;
    }

    if (killedForAskUserQuestion) {
      if ((finished.queuedMessages?.length ?? 0) > 0) {
        setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
      }
      return;
    }

    // Auto-continue after ExitPlanMode (same as CLI runner)
    const lastToolUse = [...turnState.blocks].reverse().find(
      (b): b is ContentBlock & { type: "tool_use" } => b.type === "tool_use",
    );
    if (lastToolUse && lastToolUse.name === "ExitPlanMode" && turnState.sessionId) {
      setImmediate(() => {
        this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((err) => {
          console.error("[WAND] sdk auto-continue after ExitPlanMode failed:", err);
        });
      });
      return;
    }

    setImmediate(() => { void this.flushNextQueuedMessage(sessionId); });
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers (unchanged logic, extracted from previous implementation)
  // ---------------------------------------------------------------------------

  private extractAssistantMessage(message: Record<string, unknown>): {
    content: ContentBlock[];
    usage?: ConversationTurn["usage"];
  } {
    const rawContent = Array.isArray(message.content) ? message.content : [];
    const content: ContentBlock[] = [];
    for (const block of rawContent) {
      if (!block || typeof block !== "object") continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
        content.push({ type: "text", text: typedBlock.text });
        continue;
      }
      if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
        content.push({ type: "thinking", thinking: typedBlock.thinking });
        continue;
      }
      if (typedBlock.type === "tool_use" && typeof typedBlock.id === "string" && typeof typedBlock.name === "string") {
        content.push({
          type: "tool_use",
          id: typedBlock.id,
          name: typedBlock.name,
          description: typeof typedBlock.description === "string" ? typedBlock.description : undefined,
          input: this.normalizeToolInput(typedBlock.name, typedBlock.input),
        });
      }
    }
    return {
      content,
      usage: this.extractUsage({ usage: message.usage }),
    };
  }

  private compactContentBlocks(blocks: ContentBlock[], fallbackResult: string): ContentBlock[] {
    const compacted: ContentBlock[] = [];
    for (const block of blocks) {
      const previous = compacted[compacted.length - 1];
      if (
        previous
        && previous.type === "text"
        && block.type === "text"
        // 子 agent 边界不合并：父 assistant 的 text 与子 agent 的 text 必须保持独立，
        // 渲染层才能切段并给子 agent 单独发头像。同一 subagent 内部允许合并。
        && (previous.__subagent?.taskId ?? null) === (block.__subagent?.taskId ?? null)
      ) {
        // 用新对象替换 compacted 末尾，**不要**就地改 previous.text —— previous
        // 通常和调用方持有的 turnState.blocks 共享引用，原地 mutate 会让下次
        // syncSnapshot 把已合并的内容再合并一次，呈指数级复制。
        const merged: ContentBlock = { type: "text", text: `${previous.text}${block.text}` };
        if (previous.__subagent) merged.__subagent = previous.__subagent;
        compacted[compacted.length - 1] = merged;
        continue;
      }
      compacted.push(block);
    }

    if (compacted.length === 0) {
      return [{ type: "text", text: fallbackResult || "(无输出)" }];
    }

    const hasVisibleText = compacted.some((block) => block.type === "text" && block.text.trim().length > 0);
    if (!hasVisibleText && fallbackResult) {
      compacted.push({ type: "text", text: fallbackResult });
    }
    return compacted;
  }

  private buildCompletedAssistantMessages(current: SessionSnapshot, turnState: StreamingTurnState): ConversationTurn[] {
    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: this.compactContentBlocks([...turnState.blocks], turnState.result),
      usage: turnState.usage,
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
    else msgs.push(assistantTurn);
    return msgs;
  }

  private resolveQueuedMessagesAfterInterrupt(
    sessionId: string,
    current: SessionSnapshot,
    interruptPrompt: string | undefined,
  ): string[] | undefined {
    if (interruptPrompt && !this.preserveQueueOnInterrupt.has(sessionId)) return [];
    return current.queuedMessages;
  }

  private normalizeToolInput(name: unknown, input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {};
    }
    const record = input as Record<string, unknown>;
    // `claude -p --output-format stream-json`（默认结构化 runner）有时把数组型工具参数
    // 当成 JSON 字符串吐出来——例如 TodoWrite 的 todos 会是 "[{...}]" 而非真正的数组。
    // 所有客户端（web / iOS / Android）读的都是数组，拿到字符串就解析不出待办，进度条
    // 与 AskUserQuestion 卡片整段消失。这里按工具名把已知的数组字段反序列化回数组，
    // 让线上协议恢复成「block.input.todos = [{content,status,activeForm}]」的契约。
    const arrayFieldsByTool: Record<string, string> = {
      TodoWrite: "todos",
      AskUserQuestion: "questions",
    };
    const field = typeof name === "string" ? arrayFieldsByTool[name] : undefined;
    if (field && typeof record[field] === "string") {
      try {
        const parsed = JSON.parse(record[field] as string);
        if (Array.isArray(parsed)) record[field] = parsed;
      } catch {
        /* 保留原字符串：宁可不改也不要丢数据 */
      }
    }
    return record;
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

  private applyCodexLooseEvent(turnState: StreamingTurnState, event: Record<string, unknown> | null): boolean {
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
    turnState: StreamingTurnState,
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

  /**
   * 组装结构化 runner 退出失败时的可读错误字符串。
   *
   * 痛点：之前 claude -p / codex exec 异常退出只把"stderr.trim() || `... exited
   * with code N`"塞给 UI。如果 stderr 是空的，用户在前端只能看到 "EXIT 1" 这种
   * 没有任何上下文的串，根本不知道是网络错误、参数错误还是 binary 找不着。
   *
   * 这里固定把"provider + 退出码 / 信号"放在最前面，再把 stderr / NDJSON 错误
   * 事件 / 最后一段 stdout 之类的上下文跟在后面，方便定位。
   */
  private formatStructuredExitError(
    provider: "claude -p" | "codex exec" | "opencode run",
    code: number | null,
    signal: NodeJS.Signals | null,
    options: {
      /** stderr 累积内容；空字符串也行。 */
      stderr?: string;
      /** 从 NDJSON 解析出的最关键的错误消息（codex turn.failed / claude system.error）。 */
      primary?: string | null;
      /** 备用错误条目（按时间顺序排列，取最后一条）。 */
      extras?: string[];
      /** 当 stderr / primary / extras 都空时的兜底 tail，比如最后一行 stdout。 */
      stdoutTail?: string;
    } = {},
  ): string {
    const head = signal
      ? `${provider} terminated by signal ${signal}${code !== null ? ` (code ${code})` : ""}`
      : code !== null
        ? `${provider} exited with code ${code}`
        : `${provider} exited (unknown status)`;

    const primary = options.primary?.trim();
    const stderrTrim = options.stderr?.trim() ?? "";
    const lastExtra = options.extras && options.extras.length > 0
      ? options.extras[options.extras.length - 1].trim()
      : "";
    const stdoutTail = options.stdoutTail?.trim() ?? "";

    // 选第一个非空的"详情"作为正文展示，剩下的不再追加避免太长。
    const detail = primary || lastExtra || stderrTrim || stdoutTail;
    if (!detail) return head;
    // 控制长度，避免大段 stderr 撑爆 UI；保留尾部信息（最近的更相关）。
    const trimmed = detail.length > 2048 ? `...${detail.slice(-2048)}` : detail;
    return `${head}\n${trimmed}`;
  }

  private finishStructuredFailure(
    current: SessionSnapshot,
    code: number,
    errorText: string,
    turnState: StreamingTurnState,
  ): SessionSnapshot {
    const failureTurn: ConversationTurn = {
      role: "assistant",
      content: [{ type: "text", text: `结构化会话执行失败：${errorText}` }],
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = failureTurn;
    else msgs.push(failureTurn);
    return {
      ...current,
      status: "failed",
      exitCode: code,
      endedAt: new Date().toISOString(),
      output: errorText,
      claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
      messages: msgs,
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(current.structuredState as StructuredSessionState),
        model: turnState.model ?? current.structuredState?.model,
        inFlight: false,
        activeRequestId: null,
        lastError: errorText,
      },
    };
  }

  private extractModelName(modelUsage: Record<string, unknown> | undefined): string | undefined {
    if (!modelUsage) return undefined;
    const names = Object.keys(modelUsage);
    return names.length > 0 ? names[0] : undefined;
  }

  private extractUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
    if (!source || !source.usage || typeof source.usage !== "object") {
      return undefined;
    }
    const usage = source.usage as Record<string, unknown>;
    const value = {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
      cacheReadInputTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
      cacheCreationInputTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
      totalCostUsd: typeof source.total_cost_usd === "number" ? source.total_cost_usd : undefined,
    };
    if (
      value.inputTokens === undefined
      && value.outputTokens === undefined
      && value.cacheReadInputTokens === undefined
      && value.cacheCreationInputTokens === undefined
      && value.totalCostUsd === undefined
    ) {
      return undefined;
    }
    return value;
  }

  /** Extract usage from an SDKResultSuccess message (sdk runner). */
  private extractSdkUsage(result: Record<string, unknown>): ConversationTurn["usage"] {
    const usage = result?.usage as Record<string, unknown> | undefined;
    const value = {
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
      cacheReadInputTokens: typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
      cacheCreationInputTokens: typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
      totalCostUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    };
    if (Object.values(value).every(v => v === undefined)) return undefined;
    return value;
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
