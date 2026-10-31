import { CardExpandDefaults, ContentBlock, ConversationTurn, ExecutionMode, HarnessSessionContext, ProcessEvent, SessionRunner, SessionSnapshot } from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { stampNewToolUseTimes } from "./tool-use-timestamps.js";
import { compactTransportAvatar } from "./fixed-employee-avatar.js";
import { CodexProtocolReducer } from "./structured-codex-protocol.js";
import { ClaudeCliProtocolReducer } from "./structured-claude-protocol.js";
import { applyOpenCodeEvent } from "./structured-opencode-adapter.js";
import { applyGrokEvent } from "./structured-grok-adapter.js";
import { applyPiEvent } from "./structured-pi-adapter.js";
import { lastPiAssistantMessage } from "./pi-event-projection.js";
import type { StructuredCompactionNotice, StructuredRunnerTurnState } from "./structured-runner.js";
import { normalizeTurnAnchors } from "./structured-provider-common.js";
import { enrichStructuredMessages, WAND_PROTOCOL_VERSION } from "./structured-client-protocol.js";

export interface ReplayProcessor {
  state: StructuredRunnerTurnState;
  stderr: string;
  primaryError: string | null;
  errors?: string[];
  stdoutTail?: string;
  stopReason?: "ask-user-question";
  askUserQuestionDetected?: boolean;
  /** Feed one complete stdout line; returns true when turn state changed. */
  feed(line: string, observedAt?: string): boolean;
}

export function buildReplayProcessor(session: SessionSnapshot): ReplayProcessor {
  const runner = session.runner;
  if (runner === "codex-cli-exec") {
    const reducer = new CodexProtocolReducer(session);
    return {
      state: reducer.state,
      stderr: "",
      get primaryError() { return reducer.primaryError; },
      get errors() { return reducer.errors; },
      feed: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return false; }
        return reducer.apply(event);
      },
    };
  }
  if (runner === "claude-cli-print" || runner === "qoder-cli-print") {
    const reducer = new ClaudeCliProtocolReducer(session);
    const managed = session.mode === "managed";
    const processor: ReplayProcessor = {
      state: reducer.state,
      stderr: "",
      primaryError: null,
      stdoutTail: "",
      get askUserQuestionDetected() { return reducer.askUserQuestionDetected; },
      get stopReason() { return reducer.askUserQuestionDetected ? "ask-user-question" as const : undefined; },
      feed: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        processor.stdoutTail = trimmed.slice(-1024);
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return false; }
        if (runner === "qoder-cli-print" && event && typeof event === "object" && !Array.isArray(event)) {
          const record = event as Record<string, unknown>;
          if (record.type === "result" && record.subtype !== "success") {
            const errors = Array.isArray(record.errors)
              ? record.errors.filter((item): item is string => typeof item === "string")
              : [];
            processor.primaryError = errors.join("\n") || "Qoder CLI execution failed";
          }
        }
        return reducer.apply(event, managed);
      },
    };
    return processor;
  }
  // grok-cli-headless / opencode-cli-run / pi-cli-json share the same shape.
  const state: StructuredRunnerTurnState = {
    blocks: [],
    result: "",
    sessionId: session.claudeSessionId,
    model: session.selectedModel ?? session.structuredState?.model,
    ...(runner === "opencode-cli-run" ? { usage: undefined } : {}),

  };
  const processor: ReplayProcessor = {
    state,
    stderr: "",
    primaryError: null,
    feed: (line, observedAt) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let event: Record<string, unknown>;
      try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { return false; }
      const error = runner === "grok-cli-headless"
        ? applyGrokEvent(state as Parameters<typeof applyGrokEvent>[0], event)
        : runner === "opencode-cli-run"
          ? applyOpenCodeEvent(state, event)
          : applyPiEvent(state, event, observedAt);
      if (error) processor.primaryError = error;
      else if (runner === "pi-cli-json") {
        const lastAssistant = lastPiAssistantMessage(event);
        // Match live PiRunner: a later successful answer supersedes an error
        // that Pi recovered internally, while a terminal error stays a failure.
        if (lastAssistant && lastAssistant.stopReason !== "error") processor.primaryError = null;
      }
      return true;
    },
  };
  return processor;
}

export function recoveredCommandLabel(runner: SessionRunner | undefined): string {
  switch (runner) {
    case "codex-cli-exec": return "codex exec";
    case "opencode-cli-run": return "opencode run";
    case "grok-cli-headless": return "grok -p --output-format streaming-json";
    case "qoder-cli-print": return "qodercli -p --output-format stream-json";
    case "pi-cli-json": return "pi --mode json";
    default: return "claude -p";
  }
}


export interface StreamingCheckpointDirty {
  metadata: boolean;
  output: boolean;
  messages: boolean;
}

/**
 * 找出最后一条 assistant turn 中尚未配对 tool_result 的 AskUserQuestion tool_use。
 * 用来识别"刚被 SIGTERM 中断、正在等用户提交答案"的状态。
 */
export function findUnpairedAskUserQuestion(
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
export function withSummary(snapshot: SessionSnapshot): SessionSnapshot {
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
export function shouldAutoApproveForMode(mode: ExecutionMode): boolean {
  return mode === "full-access" || mode === "managed" || mode === "auto-edit";
}

/** Quiet heartbeat is a status ping, not another copy of the transcript or uploaded avatar. */
export function structuredQuietStatusData(session: SessionSnapshot): Record<string, unknown> {
  return {
    sessionKind: "structured",
    status: session.status,
    exitCode: session.exitCode,
    structuredState: normalizeTurnAnchors(session.structuredState),
    provider: session.provider,
    runner: session.runner,
    selectedModel: session.selectedModel,
    thinkingEffort: session.thinkingEffort,
    employeeId: session.employeeId,
    employeeName: session.employeeName,
    employeeAvatar: compactTransportAvatar(session.employeeAvatar),
    employeeCandidateIndex: session.employeeCandidateIndex,
    title: session.title,
    description: session.description,
    summary: session.description ?? session.summary,
  };
}

export function buildStructuredOutputPayload(snapshot: SessionSnapshot): ProcessEvent["data"] {
  return {
    wandProtocolVersion: WAND_PROTOCOL_VERSION,
    output: snapshot.output,
    messages: snapshot.messages ? enrichStructuredMessages(snapshot.messages, snapshot.id) : undefined,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    provider: snapshot.provider,
    runner: snapshot.runner,
    selectedModel: snapshot.selectedModel,
    thinkingEffort: snapshot.thinkingEffort,
    employeeId: snapshot.employeeId,
    employeeName: snapshot.employeeName,
    employeeAvatar: compactTransportAvatar(snapshot.employeeAvatar),
    employeeCandidateIndex: snapshot.employeeCandidateIndex,
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

export function buildIncrementalStructuredPayload(
  snapshot: SessionSnapshot,
  cardDefaults: CardExpandDefaults,
): ProcessEvent["data"] {
  const messages = snapshot.messages ?? [];
  // Derive semantics from the complete current turn before taking the
  // incremental tail; TaskCreate results can live in an earlier provider frame.
  const clientMessages = enrichStructuredMessages(messages, snapshot.id);
  const lastTurn = clientMessages.length > 0 ? clientMessages[clientMessages.length - 1] : undefined;
  // Streaming turn (index 0 here) is preserved verbatim; truncation only kicks
  // in if the live response is already bigger than the transport threshold,
  // matching the PTY runner's behaviour in process-manager.ts.
  const lastMessage = lastTurn ? truncateMessagesForTransport([lastTurn], cardDefaults, 0)[0] : undefined;
  return {
    wandProtocolVersion: WAND_PROTOCOL_VERSION,
    incremental: true,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
    lastMessage,
    messageCount: messages.length,
  };
}

export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Identity of one content block inside an assistant turn. Tool ids are copied
 * verbatim from the CLI stream and never mutate, so they are the anchors used to
 * align a replayed turn with the transcript we already stored.
 */
function replayBlockAnchor(block: ContentBlock): string | null {
  switch (block.type) {
    case "tool_use": return `tool_use:${block.id}`;
    case "tool_result": return `tool_result:${block.tool_use_id}`;
    case "thinking": return `thinking:${block.thinking}`;
    case "text": return `text:${block.text}`;
    default: return null;
  }
}

/**
 * Index of the last replayed block the stored turn already contains, or -1 when
 * no overlap can be proven.
 *
 * Needed because a daemon replay log can start mid-stream
 * (STRUCTURED_RUN_LOG_MAX_CHARS), so the first replayed blocks usually repeat the
 * tail of the turn we accumulated live before the restart.
 */
function lastStoredAnchorIndex(stored: ContentBlock[] | null, replayed: ContentBlock[]): number {
  if (!stored || stored.length === 0) return -1;
  const known = new Set<string>();
  for (const block of stored) {
    const anchor = replayBlockAnchor(block);
    if (anchor !== null) known.add(anchor);
  }
  let cut = -1;
  for (let index = 0; index < replayed.length; index += 1) {
    const anchor = replayBlockAnchor(replayed[index]);
    if (anchor !== null && known.has(anchor)) cut = index;
  }
  return cut;
}

/**
 * 截断重放期间「本地已存 turn + replay 新增段」的合并视图。
 *
 * 重启后在 terminald 里继续跑的 CLI 只保留最后 STRUCTURED_RUN_LOG_MAX_CHARS 字符的
 * stdout，replay 出来的是「半截尾巴」：直接用它覆盖会删掉重启前用户已经看到的输出，
 * 完全不用它又会让前端冻结到本轮结束。所以把 checkpoint 里的 turn 当固定底，只把
 * replay 里能证明是新增的那段拼在后面。cut 只算一次，视图随 replay 增长而增长
 * （保持流式），且重复调用幂等（不会重复追加、也不会丢底）。
 */
export class TruncatedReplayView {
  private readonly base: ContentBlock[] | null;
  private cut = -1;
  private primed = false;

  constructor(messages: ConversationTurn[] | undefined) {
    const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
    this.base = last && last.role === "assistant" ? last.content : null;
  }

  get ready(): boolean {
    return this.primed;
  }

  /** 必须在 replay 首轮 feed 完成后再定锚点：feed 途中的半截 blocks 会把重叠判错。 */
  prime(replayed: ContentBlock[]): void {
    this.cut = lastStoredAnchorIndex(this.base, replayed);
    this.primed = true;
  }

  content(replayed: ContentBlock[]): ContentBlock[] {
    if (!this.base || this.base.length === 0) return replayed;
    // 证明不了重叠就只信本地已存内容（宁可暂不追加，也不要重复整段）。
    if (!this.primed || this.cut === -1) return this.base;
    const extra = replayed.slice(this.cut + 1);
    return extra.length === 0 ? this.base : [...this.base, ...extra];
  }
}

/** Append a standalone notice turn without touching the previous assistant turn. */
export function appendNoticeTurn(messages: ConversationTurn[] | undefined, turn: ConversationTurn): ConversationTurn[] {
  return [...(messages ?? []), { ...turn, createdAt: isoNow(), completedAt: isoNow() }];
}

/** core 引擎的压缩通知 → 可持久化的会话上下文（历史不删，只记切点与摘要）。 */
export function compactionToSessionContext(notice: StructuredCompactionNotice): HarnessSessionContext {
  return {
    summary: notice.summary,
    fromTurnIndex: notice.fromTurnIndex,
    tokensBefore: notice.tokensBefore,
    compactions: notice.compactions,
  };
}

export function cancelPendingResourceSelection(messages: ConversationTurn[] | undefined): ConversationTurn[] | undefined {
  const last = messages?.at(-1);
  if (!messages || last?.role !== "assistant" || last.resourceSelection?.status !== "selecting") return messages;
  return [...messages.slice(0, -1), { ...last, completedAt: isoNow(), resourceSelection: {
    ...last.resourceSelection, status: "cancelled", label: "本轮自动选择已取消",
  } }];
}

/** Replace one Pi segment after a native steering input; earlier turns stay untouched. */
export function upsertPiAssistantSegment(
  messages: ConversationTurn[] | undefined,
  turn: ConversationTurn,
  inputMessageId: string,
  complete = false,
): ConversationTurn[] {
  const msgs = [...(messages ?? [])];
  let at = -1;
  for (let index = msgs.length - 1; index >= 0; index--) {
    if (msgs[index].role === "user" && msgs[index].messageId === inputMessageId) { at = index; break; }
  }
  if (at < 0) return upsertAssistantMessage(msgs, turn, complete, false);
  const previous = msgs[at + 1]?.role === "assistant" && !msgs[at + 1].notice ? msgs[at + 1] : undefined;
  const next: ConversationTurn = { ...turn, createdAt: previous?.createdAt ?? turn.createdAt ?? isoNow(),
    content: stampNewToolUseTimes(turn.content, previous?.content, isoNow(), true),
    ...(turn.resourceSelection ? {} : previous?.resourceSelection ? { resourceSelection: previous.resourceSelection } : {}),
  };
  if (complete) next.completedAt = previous?.completedAt ?? isoNow();
  else if (previous?.completedAt) next.completedAt = previous.completedAt;
  if (previous) msgs[at + 1] = next;
  else msgs.splice(at + 1, 0, next);
  return msgs;
}

export function upsertAssistantMessage(
  messages: ConversationTurn[] | undefined,
  turn: ConversationTurn,
  complete = false,
  stampNewTools = true,
): ConversationTurn[] {
  const msgs = [...(messages ?? [])];
  const last = msgs[msgs.length - 1];
  const observedAt = isoNow();
  const createdAt = (last?.role === "assistant" ? last.createdAt : undefined) ?? turn.createdAt ?? observedAt;
  const next: ConversationTurn = {
    ...turn,
    ...(turn.resourceSelection ? { resourceSelection: turn.resourceSelection }
      : last?.role === "assistant" && last.resourceSelection ? { resourceSelection: last.resourceSelection } : {}),
    createdAt,
    content: stampNewToolUseTimes(
      turn.content, last?.role === "assistant" ? last.content : undefined, observedAt, stampNewTools,
    ),
  };
  if (complete) next.completedAt = isoNow();
  else if (last?.role === "assistant" && last.completedAt) next.completedAt = last.completedAt;
  if (last?.role === "assistant") msgs[msgs.length - 1] = next;
  else msgs.push(next);
  return msgs;
}
