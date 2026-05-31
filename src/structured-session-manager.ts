import { randomUUID } from "node:crypto";
import { spawn, ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { query as sdkQuery, type Options as SdkOptions, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { prepareSessionWorktree } from "./git-worktree.js";

import { SessionLogger } from "./session-logger.js";
import { WandStorage } from "./storage.js";
import {
  CardExpandDefaults, ContentBlock, ConversationTurn, EscalationRequest, EscalationScope,
  ExecutionMode, ProcessEvent, SessionProvider, SessionRunner, SessionSnapshot, StructuredSessionState,
  SubagentMeta, WandConfig,
} from "./types.js";
import { truncateMessagesForTransport } from "./message-truncator.js";
import { buildChildEnv } from "./env-utils.js";
import { buildLanguageDirective } from "./language-prompt.js";

interface CreateStructuredSessionOptions {
  cwd: string;
  mode: ExecutionMode;
  prompt?: string;
  provider?: SessionProvider;
  runner?: SessionRunner;
  worktreeEnabled?: boolean;
  /** 用户指定的 Claude 模型（别名或完整 ID）。留空则 spawn 时不加 --model。 */
  model?: string;
  /** 用户预设的思考深度。留空 / null 视为 off。 */
  thinkingEffort?: SessionSnapshot["thinkingEffort"];
  /**
   * 恢复用的初始会话 id：
   *   - Codex：历史 thread id，首条消息即 `codex exec ... resume <id>` 续接。
   *   - Claude：历史 session id，首条消息即 `--resume` / SDK resume 续接。
   * 留空表示新建会话。
   */
  claudeSessionId?: string;
}

function defaultStructuredRunner(provider: SessionProvider): SessionRunner {
  return provider === "codex" ? "codex-cli-exec" : "claude-cli-print";
}

function defaultStructuredState(provider: SessionProvider, runner = defaultStructuredRunner(provider)): StructuredSessionState {
  return {
    provider,
    runner,
    lastError: null,
    inFlight: false,
    activeRequestId: null,
  };
}

/**
 * 把任意外部输入收敛到合法的 thinkingEffort 枚举值。`null` / 非法值都视为
 * "未设置"——上层调用方再根据 provider 决定是否填默认值。
 */
export function normalizeThinkingEffort(
  value: unknown,
): SessionSnapshot["thinkingEffort"] {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "off" || v === "standard" || v === "deep" || v === "max") return v;
  return null;
}

/** Claude SDK 用：把 thinkingEffort 映射成 `thinking.budget_tokens`。off / 空 → 0（不启用）。 */
export function thinkingEffortToSdkBudget(effort: SessionSnapshot["thinkingEffort"]): number {
  switch (effort) {
    case "standard": return 4096;
    case "deep": return 16000;
    case "max": return 31999;
    case "off":
    default: return 0;
  }
}

/**
 * Claude CLI 用：在 prompt 前注入魔法词，让 claude code 自动识别为思考请求。
 * off → 原 prompt 不变。
 */
export function applyThinkingEffortToPrompt(
  prompt: string,
  effort: SessionSnapshot["thinkingEffort"],
): string {
  const trimmed = prompt.trimStart();
  if (!trimmed) return prompt;
  let prefix = "";
  switch (effort) {
    case "standard": prefix = "think. "; break;
    case "deep": prefix = "think hard. "; break;
    case "max": prefix = "ultrathink. "; break;
    case "off":
    default: return prompt;
  }
  // 用户已经手写了相同强度的指令时不重复加，避免把 "ultrathink. ultrathink." 喂给模型。
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("ultrathink") || lower.startsWith("think hard") || lower.startsWith("think very") || lower.startsWith("think harder")) {
    return prompt;
  }
  if (effort === "standard" && lower.startsWith("think")) return prompt;
  return prefix + trimmed;
}

/** Codex CLI 用：把 thinkingEffort 映射到 model_reasoning_effort 配置。off → minimal。 */
export function thinkingEffortToCodexReasoningEffort(effort: SessionSnapshot["thinkingEffort"]): string | null {
  switch (effort) {
    case "standard": return "low";
    case "deep": return "medium";
    case "max": return "high";
    case "off": return "minimal";
    default: return null;
  }
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
const STREAM_SAVE_THROTTLE_MS = 200;
const ARCHIVE_AFTER_MS = 1000 * 60 * 60 * 24;

function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
}

/**
 * 检测当前系统是否使用 musl libc（Alpine Linux 等）。
 * Node.js 进程报告中 glibcVersionRuntime 仅在 glibc 系统存在；musl 系统为 undefined。
 */
function isMuslSystem(): boolean {
  try {
    const header = (process.report?.getReport() as Record<string, unknown> | undefined)?.header as Record<string, unknown> | undefined;
    return !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * 解析 claude-agent-sdk 应使用的 native binary 路径。
 * SDK 默认在 Linux 上优先选 musl 包，但 glibc 系统（Debian/Ubuntu 等）跑不动 musl binary，
 * 会抛 "Claude Code native binary not found" 错误。这里手动按 libc 类型选正确的包，
 * 找不到时回退到系统 PATH 上的 `claude`。
 */
function resolveSdkClaudeBinary(): string | undefined {
  if (process.platform !== "linux") return undefined;

  const musl = isMuslSystem();
  const arch = process.arch;
  const require = createRequire(import.meta.url);

  // 按当前 libc 类型决定优先顺序
  const candidates = musl
    ? [`@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`, `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`]
    : [`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`, `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`];

  for (const pkg of candidates) {
    try {
      const resolved = require.resolve(pkg);
      if (existsSync(resolved)) return resolved;
    } catch {
      // 包不存在，继续
    }
  }
  return undefined;
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

/**
 * Root 模式下绕过权限的工具白名单。Claude CLI 拒绝以 root 身份用 bypassPermissions，
 * 退而求其次用 acceptEdits + 显式 allowedTools 覆盖 CWD 之外的路径。
 */
const ROOT_FALLBACK_ALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch",
];

/** 我们实际用到的权限子集——SDK PermissionMode 还包括 plan/dontAsk/auto 等，wand 用不上。 */
type WandPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

interface PermissionPolicy {
  permissionMode: WandPermissionMode;
  /** Root + (bypass|accept)、或非 bypass 模式下需要放行 MCP 工具时才有值。 */
  allowedTools: string[] | undefined;
}

/**
 * 收集当前会话可见的 MCP server 名字。
 * claude -p / SDK runner 没有交互式权限弹窗，碰到 mcp__* 工具会直接 fail with
 * "haven't granted"。用户已经在 claude 这边配过的 MCP server 视为可信，
 * 在 --allowedTools 里加 `mcp__<server>` 放行整台 server 的所有工具。
 *
 * 来源（取并集）：
 *   - ~/.claude.json 顶层 mcpServers
 *   - ~/.claude.json projects[<cwd>].mcpServers（仅当前 cwd 精确匹配）
 *   - <cwd>/.mcp.json mcpServers
 *
 * 结果按 (cwd, 各文件 mtime) 缓存，避免每次 spawn 都重读。
 */
const mcpServerCache = new Map<string, { mtimeFingerprint: string; names: string[] }>();

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch { /* missing/invalid — return null */ }
  return null;
}

function mtimeOf(filePath: string): number {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

function extractMcpServerKeys(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const mcpServers = (node as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object") return [];
  return Object.keys(mcpServers as Record<string, unknown>);
}

function collectMcpServerNames(cwd: string): string[] {
  const userConfigPath = path.join(homedir(), ".claude.json");
  const projectMcpPath = path.join(cwd, ".mcp.json");
  const fingerprint = `${mtimeOf(userConfigPath)}:${mtimeOf(projectMcpPath)}`;
  const cached = mcpServerCache.get(cwd);
  if (cached && cached.mtimeFingerprint === fingerprint) return cached.names;

  const names = new Set<string>();
  const userConfig = readJsonSafe(userConfigPath);
  if (userConfig) {
    for (const k of extractMcpServerKeys(userConfig)) names.add(k);
    const projects = userConfig.projects;
    if (projects && typeof projects === "object") {
      const entry = (projects as Record<string, unknown>)[cwd];
      for (const k of extractMcpServerKeys(entry)) names.add(k);
    }
  }
  const projectMcp = readJsonSafe(projectMcpPath);
  for (const k of extractMcpServerKeys(projectMcp)) names.add(k);

  const result = Array.from(names);
  mcpServerCache.set(cwd, { mtimeFingerprint: fingerprint, names: result });
  return result;
}

function mcpAllowEntries(cwd: string): string[] {
  // `mcp__<server>` 形式放行该 server 的所有工具，等价于 `mcp__<server>__*`。
  return collectMcpServerNames(cwd).map((name) => `mcp__${name}`);
}

/**
 * 把 (执行模式, 自动批准开关) 映射成 Claude CLI / SDK 的权限决策。
 * CLI runner 把它转成 --permission-mode / --allowedTools flag，
 * SDK runner 直接塞进 Options。两边的决策规则保持一字不差。
 *
 * cwd 用来枚举该会话能看到的 MCP server，把 `mcp__<server>` 加进 allowedTools；
 * bypassPermissions 模式下整个白名单都没意义，不附加。
 */
function derivePermissionPolicy(
  mode: ExecutionMode,
  autoApprove: boolean,
  cwd: string,
): PermissionPolicy {
  const shouldBypass = autoApprove || mode === "full-access" || mode === "managed";
  const shouldAcceptEdits = mode === "auto-edit";
  const mcpAllow = shouldBypass ? [] : mcpAllowEntries(cwd);
  const withMcp = (base: string[] | undefined): string[] | undefined => {
    if (!mcpAllow.length) return base;
    return base ? [...base, ...mcpAllow] : [...mcpAllow];
  };

  if (!isRunningAsRoot()) {
    if (shouldBypass) return { permissionMode: "bypassPermissions", allowedTools: undefined };
    if (shouldAcceptEdits) return { permissionMode: "acceptEdits", allowedTools: withMcp(undefined) };
    return { permissionMode: "default", allowedTools: withMcp(undefined) };
  }

  if (shouldBypass || shouldAcceptEdits) {
    return { permissionMode: "acceptEdits", allowedTools: withMcp(ROOT_FALLBACK_ALLOWED_TOOLS) };
  }
  return { permissionMode: "default", allowedTools: withMcp(undefined) };
}

/**
 * 拼装要追加到系统提示词里的片段：托管模式的自主决策提示 + 用户配置的语言偏好。
 * CLI runner 每段单独 push 一对 `--append-system-prompt <part>` flag，
 * SDK runner 用 "\n\n" 串成一个 appendSystemPrompt 字符串塞 Options。
 * 文本统一到这里维护，避免两个 runner 各抄一份导致漂移。
 */
function buildAppendSystemPromptParts(language: string | undefined, mode: ExecutionMode): string[] {
  const trimmedLanguage = language?.trim();
  const isChinese = trimmedLanguage === "中文";
  const parts: string[] = [];

  if (mode === "managed") {
    parts.push(
      isChinese
        ? "你正在完全托管的自主模式下运行。用户可能无法及时回复问题或确认。你必须独立做出所有决策——自行选择最佳方案，而不是向用户询问偏好、确认或澄清。如果有多种可行方案，选择你认为最合适的并继续执行。除非任务本身存在根本性的歧义且无法合理推断，否则不要等待用户输入。果断行动，自主决策。"
        : "You are running in a fully managed, autonomous mode. The user may not be available to respond to questions or confirmations in a timely manner. You MUST make all decisions independently — choose the best approach yourself instead of asking the user for preferences, confirmations, or clarifications. If multiple approaches are viable, pick the one you judge most appropriate and proceed. Never block on user input unless the task is fundamentally ambiguous and cannot be reasonably inferred. Be decisive and self-directed.",
    );
  }

  if (trimmedLanguage) {
    const directive = buildLanguageDirective(trimmedLanguage);
    if (directive) parts.push(directive);
  }

  return parts;
}

function buildStructuredOutputPayload(snapshot: SessionSnapshot): ProcessEvent["data"] {
  return {
    output: snapshot.output,
    messages: snapshot.messages,
    queuedMessages: snapshot.queuedMessages,
    sessionKind: "structured",
    structuredState: snapshot.structuredState,
  };
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
  /** Last wall-clock time (ms) we did a full saveSession for a streaming session. */
  private readonly lastStreamSaveAt = new Map<string, number>();
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

  constructor(
    private readonly storage: WandStorage,
    private readonly config: WandConfig,
    private readonly logger: SessionLogger | null = null,
  ) {
    for (const snapshot of this.storage.loadSessions()) {
      if ((snapshot.sessionKind ?? "pty") !== "structured") continue;
      const restoredStatus = snapshot.status === "running" ? "idle" : snapshot.status;
      const restored: SessionSnapshot = {
        ...snapshot,
        sessionKind: "structured",
        provider: snapshot.provider ?? snapshot.structuredState?.provider ?? "claude",
        runner: snapshot.runner ?? snapshot.structuredState?.runner ?? defaultStructuredRunner(snapshot.provider ?? snapshot.structuredState?.provider ?? "claude"),
        status: restoredStatus,
        autoApprovePermissions: snapshot.autoApprovePermissions ?? shouldAutoApproveForMode(snapshot.mode),
        approvalStats: snapshot.approvalStats ?? { tool: 0, command: 0, file: 0, total: 0 },
        queuedMessages: snapshot.queuedMessages ?? [],
        pendingEscalation: null,
        permissionBlocked: false,
        structuredState: {
          provider: snapshot.structuredState?.provider ?? snapshot.provider ?? "claude",
          runner: snapshot.runner ?? snapshot.structuredState?.runner ?? defaultStructuredRunner(snapshot.structuredState?.provider ?? snapshot.provider ?? "claude"),
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
      this.storage.saveSession(session);
    }
  }

  setEventEmitter(emitEvent: (event: ProcessEvent) => void): void {
    this.emitEvent = emitEvent;
  }

  /**
   * In-memory snapshot is updated unconditionally; the SQLite write is rate-
   * limited to once per STREAM_SAVE_THROTTLE_MS. Caller must still invoke
   * `storage.saveSession` directly at terminal events (close / failure) so the
   * final state is durable.
   */
  private saveStreamingSnapshot(snapshot: SessionSnapshot): void {
    const now = Date.now();
    const last = this.lastStreamSaveAt.get(snapshot.id) ?? 0;
    if (now - last < STREAM_SAVE_THROTTLE_MS) return;
    this.lastStreamSaveAt.set(snapshot.id, now);
    this.storage.saveSession(snapshot);
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

  createSession(options: CreateStructuredSessionOptions): SessionSnapshot {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const prompt = options.prompt?.trim();
    const provider: SessionProvider = options.provider === "codex" ? "codex" : "claude";
    const runner = options.runner ?? defaultStructuredRunner(provider);
    const worktreeSetup = options.worktreeEnabled
      ? prepareSessionWorktree({ cwd: options.cwd, sessionId: id })
      : null;
    const selectedModel = options.model?.trim() || null;
    const initialThinkingEffort = normalizeThinkingEffort(options.thinkingEffort);
    const snapshot: SessionSnapshot = {
      id,
      sessionKind: "structured",
      provider,
      runner,
      command:
        provider === "codex"
          ? "codex exec --json"
          : runner === "claude-sdk"
            ? "claude-agent-sdk (stream-json)"
            : "claude -p --output-format stream-json",
      cwd: worktreeSetup?.cwd ?? options.cwd,
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
    opts?: { interrupt?: boolean; idempotencyKey?: string; preserveQueue?: boolean },
  ): Promise<SessionSnapshot> {
    let session = this.requireSession(id);
    const prompt = input.trim();
    if (!prompt) return session;
    if (opts?.idempotencyKey) {
      const mapKey = `${id}:${opts.idempotencyKey}`;
      if (this.seenIdempotencyKeys.has(mapKey)) {
        console.log("[WAND] sendMessage: duplicate idempotency key rejected", { id, key: opts.idempotencyKey });
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
      const childAlive = child && !child.killed && child.exitCode === null;
      if (!childAlive) {
        if (child) this.pendingChildren.delete(id);
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
        this.storage.saveSession(recovered);
        session = recovered;
      } else if (opts?.interrupt) {
        this.interruptedWith.set(id, prompt);
        if (opts.preserveQueue) {
          this.preserveQueueOnInterrupt.add(id);
        } else {
          this.preserveQueueOnInterrupt.delete(id);
        }
        try { child.kill("SIGTERM"); } catch (_err) { /* ignore */ }
        const sdkQueryHandle = this.pendingSdkQueries.get(id);
        if (sdkQueryHandle) {
          void sdkQueryHandle.interrupt().catch(() => { /* ignore */ });
        }
        const sdkAbort = this.pendingSdkAbort.get(id);
        if (sdkAbort) sdkAbort.abort();
        return session;
      } else {
        const queue = [...(session.queuedMessages ?? [])];
        if (queue.length >= 10) {
          throw new Error("排队消息已满（最多 10 条），请等待当前消息处理完成。");
        }
        const queued: SessionSnapshot = {
          ...session,
          queuedMessages: [...queue, prompt],
        };
        this.sessions.set(id, queued);
        this.storage.saveSession(queued);
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
    this.storage.saveSession(updated);
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
      if ((updated.provider ?? "claude") === "codex") {
        await this.runCodexStreaming(id, updated, prompt);
      } else if (this.config.structuredRunner === "sdk") {
        await this.runClaudeSdkStreaming(id, updated, prompt);
      } else {
        await this.runClaudeStreaming(id, updated, cliClaudePrompt);
      }
      const finished = this.requireSession(id);
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.sessions.get(id);
      if (!current) throw error;
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
      this.storage.saveSession(failed);
      this.emit({
        type: "status",
        sessionId: id,
        data: { status: failed.status, error: message, sessionKind: "structured", queuedMessages: failed.queuedMessages, structuredState: failed.structuredState },
      });
      this.emitStructuredSnapshot(failed, "ended");
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Permission resolution (called from server routes)
  // ---------------------------------------------------------------------------

  /** Approve a pending permission request. */
  approvePermission(sessionId: string): SessionSnapshot {
    return this.resolvePermission(sessionId, true);
  }

  /** Deny a pending permission request. */
  denyPermission(sessionId: string): SessionSnapshot {
    return this.resolvePermission(sessionId, false);
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
    this.storage.saveSession(updated);
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
    this.storage.saveSession(updated);
    this.emitStructuredSnapshot(updated);
    return updated;
  }

  /** Clear all queued messages. No-op when queue is already empty. */
  clearQueuedMessages(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!session.queuedMessages || session.queuedMessages.length === 0) {
      return session;
    }
    const updated: SessionSnapshot = { ...session, queuedMessages: [] };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
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
    this.storage.saveSession(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", selectedModel: normalized, structuredState: updated.structuredState },
    });
    return updated;
  }

  /**
   * Update the thinking-effort level for a structured session. Takes effect on
   * the next spawn / next message (SDK runner injects `thinking`, CLI runner
   * prepends magic words, codex runner overrides `model_reasoning_effort`).
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
    this.storage.saveSession(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { sessionKind: "structured", thinkingEffort: normalized },
    });
    return updated;
  }

  /** Toggle auto-approve for the session. */
  toggleAutoApprove(sessionId: string): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const newVal = !session.autoApprovePermissions;
    const updated: SessionSnapshot = { ...session, autoApprovePermissions: newVal };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
    return updated;
  }

  /** Resolve a specific escalation by requestId. */
  resolveEscalation(sessionId: string, requestId: string, resolution?: "approve_once" | "approve_turn" | "deny"): SessionSnapshot {
    const approved = resolution !== "deny";
    const session = this.requireSession(sessionId);
    const scope = session.pendingEscalation?.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: session.pendingEscalation ? {
        requestId: session.pendingEscalation.requestId,
        resolution: approved ? "approve_once" : "deny",
        reason: approved ? "user_approved" : "user_denied",
      } : session.lastEscalationResult ?? null,
    };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
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
    const child = this.pendingChildren.get(id);
    if (child) {
      child.kill();
      this.pendingChildren.delete(id);
    }
    // SDK runner：先尝试 query.interrupt() 优雅停止，失败再走 abort。
    // 两个都清掉避免后续重复操作。
    const sdkQuery = this.pendingSdkQueries.get(id);
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.pendingSdkQueries.delete(id);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.pendingSdkAbort.delete(id);
    }
    const stopped: SessionSnapshot = {
      ...session,
      status: "stopped",
      endedAt: new Date().toISOString(),
      pendingEscalation: null,
      permissionBlocked: false,
      structuredState: {
        ...(session.structuredState ?? defaultStructuredState(session.provider ?? "claude", session.runner)),
        inFlight: false,
        activeRequestId: null,
      },
    };
    this.sessions.set(id, stopped);
    this.storage.saveSession(stopped);
      this.emitStructuredSnapshot(stopped, "ended");
    return stopped;
  }

  delete(id: string): void {
    const child = this.pendingChildren.get(id);
    if (child) {
      child.kill();
      this.pendingChildren.delete(id);
    }
    const sdkQuery = this.pendingSdkQueries.get(id);
    if (sdkQuery) {
      void sdkQuery.interrupt().catch(() => { /* ignore */ });
      this.pendingSdkQueries.delete(id);
    }
    const sdkAbort = this.pendingSdkAbort.get(id);
    if (sdkAbort) {
      sdkAbort.abort();
      this.pendingSdkAbort.delete(id);
    }
    this.sessions.delete(id);
    this.lastStreamSaveAt.delete(id);
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

  private buildQueuedPlaceholderTurns(session: SessionSnapshot): ConversationTurn[] {
    return (session.queuedMessages ?? []).map((text) => ({
      role: "user",
      content: [{ type: "text", text, __queued: true } as ContentBlock],
    }));
  }

  private buildRenderableMessages(session: SessionSnapshot): ConversationTurn[] {
    return [
      ...(session.messages ?? []),
      ...this.buildQueuedPlaceholderTurns(session),
    ];
  }

  private emitStructuredSnapshot(session: SessionSnapshot, eventType: "output" | "ended" = "output"): void {
    const payload = buildStructuredOutputPayload(session) as Record<string, unknown>;
    const data = {
      ...payload,
      messages: this.buildRenderableMessages(session),
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
    this.storage.saveSession(nextSession);
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
        this.storage.saveSession(rescued);
        this.emitStructuredSnapshot(rescued);
      }
    }
  }

  private emit(event: ProcessEvent): void {
    if (this.emitEvent) {
      this.emitEvent(event);
    }
  }

  private resolvePermission(sessionId: string, approved: boolean): SessionSnapshot {
    const session = this.requireSession(sessionId);
    const scope = session.pendingEscalation?.scope;
    if (approved && scope) {
      this.incrementApprovalStats(session, scope);
    }
    const updated: SessionSnapshot = {
      ...session,
      pendingEscalation: null,
      permissionBlocked: false,
      lastEscalationResult: session.pendingEscalation ? {
        requestId: session.pendingEscalation.requestId,
        resolution: approved ? "approve_once" : "deny",
        reason: approved ? "user_approved" : "user_denied",
      } : session.lastEscalationResult ?? null,
    };
    this.sessions.set(sessionId, updated);
    this.storage.saveSession(updated);
    this.emit({
      type: "status",
      sessionId,
      data: { permissionBlocked: false, approvalStats: updated.approvalStats, sessionKind: "structured" },
    });
    return updated;
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
  // CLI argument construction
  // ---------------------------------------------------------------------------
  // claude CLI 的权限/系统提示 flag 由模块级 derivePermissionPolicy() +
  // buildAppendSystemPromptParts() 派生，定义在文件顶部，与 SDK runner 共用。

  private buildCodexArgs(session: SessionSnapshot): string[] {
    const args = ["exec", "--json", "--color", "never"];
    const shouldBypass = session.autoApprovePermissions === true || session.mode === "full-access" || session.mode === "managed";
    if (shouldBypass) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (session.mode === "auto-edit" || session.mode === "agent" || session.mode === "agent-max") {
      args.push("--sandbox", "workspace-write");
    } else {
      args.push("--sandbox", "read-only");
    }
    args.push("--skip-git-repo-check");
    const modelChoice = session.selectedModel?.trim();
    if (modelChoice && modelChoice !== "default") {
      args.push("--model", modelChoice);
    }
    // 思考深度 → model_reasoning_effort（off → minimal，standard → low，deep → medium，max → high）
    // Newer Codex CLI versions removed the old dedicated exec flag, but still
    // accept config overrides through `-c`.
    const reasoningEffort = thinkingEffortToCodexReasoningEffort(session.thinkingEffort);
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
    }
    if (session.claudeSessionId) {
      args.push("resume", session.claudeSessionId, "-");
    } else {
      args.push("-");
    }
    return args;
  }

  // ---------------------------------------------------------------------------
  // Streaming codex exec --json execution
  // ---------------------------------------------------------------------------

  private runCodexStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = this.buildCodexArgs(session);
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
        usage: undefined,
        codexBlockIndex: new Map(),
      };
      let lineBuf = "";
      let stderr = "";
      let emitTimer: ReturnType<typeof setTimeout> | null = null;
      // codex 把所有错误（包括重试日志和最终失败原因）都通过 stdout 的 NDJSON 事件
      // 输出，stderr 通常是空的。我们在 processLine 里收集这些，然后在 close 中
      // 决定真正的报错文本。
      const codexErrors: string[] = [];
      let codexTurnFailed: string | null = null;

      const flushEmit = (): void => {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        const current = this.sessions.get(sessionId);
        if (!current) return;
        this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
      };

      const syncSnapshot = (): void => {
        const current = this.sessions.get(sessionId);
        if (!current) return;
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
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try { parsed = JSON.parse(trimmed); } catch { return; }
        this.logger?.appendStreamEvent(sessionId, parsed);
        if (parsed?.type === "thread.started" && typeof parsed.thread_id === "string") {
          turnState.sessionId = parsed.thread_id;
          syncSnapshot();
          return;
        }
        if (parsed?.type === "item.started" && parsed.item) {
          this.applyCodexItem(turnState, parsed.item, "started");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (parsed?.type === "item.updated" && parsed.item) {
          // codex `item.updated` 重新发送完整 ThreadItem（不是 delta）。
          // 对 text/thinking/TodoWrite 走 codexBlockIndex 替换；对 tool_use
          // 仍然按现有 id 复用，避免重复卡片。
          this.applyCodexItem(turnState, parsed.item, "updated");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (parsed?.type === "item.completed" && parsed.item) {
          this.applyCodexItem(turnState, parsed.item, "completed");
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (parsed?.type === "turn.completed") {
          turnState.usage = this.extractCodexUsage(parsed.usage) ?? turnState.usage;
          syncSnapshot();
          scheduleEmit();
          return;
        }
        if (parsed?.type === "error") {
          const message = typeof parsed.message === "string" ? parsed.message : "";
          if (message) codexErrors.push(message);
          return;
        }
        if (parsed?.type === "turn.failed") {
          const errObj = (parsed.error && typeof parsed.error === "object") ? parsed.error as Record<string, unknown> : null;
          const message = (errObj && typeof errObj.message === "string" && errObj.message)
            || (typeof parsed.message === "string" ? parsed.message : "")
            || "codex turn failed";
          codexTurnFailed = message;
          return;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStdout(sessionId, text);
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
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
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
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
        const current = this.sessions.get(sessionId);
        if (!current) {
          reject(new Error("Session removed during execution."));
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
          this.storage.saveSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          reject(new Error(errorText));
          return;
        }
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          content: this.compactContentBlocks([...turnState.blocks], turnState.result),
          usage: turnState.usage,
        };
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
        else msgs.push(assistantTurn);
        const keepRunning = !!interruptPrompt;
        const finished: SessionSnapshot = {
          ...current,
          status: keepRunning ? "running" : "idle",
          exitCode: keepRunning ? null : 0,
          endedAt: keepRunning ? null : new Date().toISOString(),
          output: turnState.result,
          claudeSessionId: turnState.sessionId ?? current.claudeSessionId,
          messages: msgs,
          queuedMessages: interruptPrompt && !this.preserveQueueOnInterrupt.has(sessionId) ? [] : current.queuedMessages,
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
        this.storage.saveSession(finished);
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
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] codex interrupt-and-send failed:", err);
              const afterFail = this.sessions.get(sessionId);
              if (afterFail) {
                const recovered: SessionSnapshot = {
                  ...afterFail,
                  status: "idle",
                  exitCode: 0,
                  endedAt: new Date().toISOString(),
                  structuredState: {
                    ...(afterFail.structuredState as StructuredSessionState),
                    inFlight: false,
                    activeRequestId: null,
                  },
                };
                this.sessions.set(sessionId, recovered);
                this.storage.saveSession(recovered);
                this.emitStructuredSnapshot(recovered);
              }
            });
          });
          return;
        }
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
  private runClaudeStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ["-p", "--verbose", "--output-format", "stream-json"];

      // 权限策略：决策规则与 SDK runner 共享 derivePermissionPolicy()，CLI 这边把
      // 结果转成对应的 flag。--allowedTools 是 commander 的 variadic（<tools...>），
      // 紧跟其后的所有非 flag 形 token 都会被吞进工具列表，因此后面任何位置参数
      // 都得是 -- 开头的 flag——下面追加 --append-system-prompt / --model / --resume
      // 都满足这个条件。
      const permPolicy = derivePermissionPolicy(session.mode, session.autoApprovePermissions ?? false, session.cwd);
      if (permPolicy.permissionMode !== "default") {
        args.push("--permission-mode", permPolicy.permissionMode);
      }
      if (permPolicy.allowedTools) {
        args.push("--allowedTools", ...permPolicy.allowedTools);
      }

      // 追加系统提示词（托管模式自主决策 + 语言偏好），文本与 SDK runner 共享。
      for (const part of buildAppendSystemPromptParts(this.config.language, session.mode)) {
        args.push("--append-system-prompt", part);
      }

      const modelChoice = session.selectedModel?.trim();
      if (modelChoice && modelChoice !== "default") {
        args.push("--model", modelChoice);
      }

      // 托管模式：禁用 AskUserQuestion，让 agent 自己拍板，不要等用户决策。
      // 非托管模式：保留工具，靠 processLine 检测后主动 kill child 触发"中断+续接"流程。
      const isManaged = session.mode === "managed";
      if (isManaged) {
        args.push("--disallowedTools", "AskUserQuestion");
      }

      if (session.claudeSessionId) {
        args.push("--resume", session.claudeSessionId);
      }

      // 通过 stdin 传 prompt，避免被 --allowedTools / --disallowedTools 这类
      // variadic 参数贪婪吞掉（commander 的 <tools...> 会一直吃 positional 直到
      // 下一个 flag）。表现为 claude 报 "Input must be provided either through
      // stdin or as a prompt argument when using --print"。
      //
      // 思考深度通过给 prompt 前置魔法词触发（think / think hard / ultrathink）。
      // applyThinkingEffortToPrompt 自身已经做了"用户已写过就不重复加"的保护。
      const effectivePrompt = applyThinkingEffortToPrompt(prompt, session.thinkingEffort);
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
        prompt: effectivePrompt.slice(0, 2048),
        promptLength: effectivePrompt.length,
        claudeSessionId: session.claudeSessionId,
        spawnedAt,
      });
      this.pendingChildren.set(sessionId, child);
      child.stdin?.end(effectivePrompt);

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
        // 新规则：当类型不一致时，把新 block **追加**到 merged 末尾而非覆盖 prev。
        // 既兼容 a)（同位置同类型仍按累积取大），又兼容 b)（拼接的新类型 block
        // 进入末尾），还能挡住 b 早期版本里"短回退"的异常 frame（blocks.length
        // < prev.length 时直接拒绝）。
        if (blocks.length < prev.length) return;
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

      // 当 Claude 在非托管模式调用 AskUserQuestion 时，stdin 关闭导致它会 hang 等
      // tool_result。我们检测到后主动 kill child，让它顺利退出，UI 把 tool_use 卡片
      // 渲染成可交互选项；用户提交后由 sendMessage() 通过 --resume 续接。
      let killedForAskUserQuestion = false;

      const flushEmit = (): void => {
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = null;
        }
        const current = this.sessions.get(sessionId);
        if (!current) return;
        this.emit({
          type: "output",
          sessionId,
          data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}),
        });
      };

      const scheduleEmit = (): void => {
        if (!emitTimer) {
          emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
        }
      };

      /** Update the session snapshot with the current in-progress assistant turn. */
      const syncSnapshot = (): void => {
        const current = this.sessions.get(sessionId);
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

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        this.logger?.appendStreamEvent(sessionId, parsed);

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
          if (typeof parsed.session_id === "string") {
            turnState.sessionId = parsed.session_id;
          }
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
        const text = chunk.toString();
        this.logger?.appendStructuredStderr(sessionId, text);
        stderr += text;
      });

      child.on("error", (error) => {
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
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
        this.pendingChildren.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
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
        const current = this.sessions.get(sessionId);
        if (!current) {
          reject(new Error("Session removed during execution."));
          return;
        }

        // 如果是用户主动中断（interruptedWith 里有新消息），claude -p 收到 SIGTERM 后
        // 可能以非零 exit code 退出（内部 handler 调了 exit(1)）。这种情况属于正常
        // 中断流程，不应走失败路径——后续 interruptedWith 逻辑会发送新消息。
        const interruptedByUser = this.interruptedWith.has(sessionId);
        const failedExit = (code !== null && code !== 0) || signal !== null;
        if (failedExit && !interruptedByUser) {
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
          this.storage.saveSession(failed);
          this.emitStructuredSnapshot(failed);
          this.emitStructuredSnapshot(failed, "ended");
          reject(new Error(errorText));
          return;
        }

        // Build the final assistant turn.
        const finalContent = this.compactContentBlocks([...turnState.blocks], turnState.result);
        const assistantTurn: ConversationTurn = {
          role: "assistant",
          content: finalContent,
          usage: turnState.usage,
        };

        // Ensure the final messages list has the completed assistant turn.
        const msgs = [...(current.messages ?? [])];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          msgs[msgs.length - 1] = assistantTurn;
        } else {
          msgs.push(assistantTurn);
        }

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
          queuedMessages: interruptPrompt && !this.preserveQueueOnInterrupt.has(sessionId) ? [] : current.queuedMessages,
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
        this.storage.saveSession(finished);

        this.emitStructuredSnapshot(finished);
        if (!keepRunning) {
          this.emitStructuredSnapshot(finished, "ended");
        }

        // 等待用户回答 AskUserQuestion 时，跳过后续自续接和队列推进。
        if (killedForAskUserQuestion) {
          resolve();
          return;
        }

        // 用户中断当前回复：保存部分回复后立即发送新消息。
        if (interruptPrompt) {
          this.interruptedWith.delete(sessionId);
          // 把"保留队列"标记一并清掉——不属于本次 interrupt 的后续轮次会按
          // 默认（清空 queue）行为走，避免 stale flag 影响下一次普通 interrupt。
          // 注意：被保留的 queuedMessages 不需要在这里主动 flush，重发的
          // interruptPrompt 跑完会自然触发 flushNextQueuedMessage。
          this.preserveQueueOnInterrupt.delete(sessionId);
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, interruptPrompt).catch((err) => {
              console.error("[WAND] interrupt-and-send failed:", err);
              // 续接失败：把状态回滚到 idle，让用户可以重新输入而不是卡在 running 状态
              const afterFail = this.sessions.get(sessionId);
              if (afterFail) {
                const recovered: SessionSnapshot = {
                  ...afterFail,
                  status: "idle",
                  exitCode: 0,
                  endedAt: new Date().toISOString(),
                  structuredState: {
                    ...(afterFail.structuredState as StructuredSessionState),
                    inFlight: false,
                    activeRequestId: null,
                  },
                };
                this.sessions.set(sessionId, recovered);
                this.storage.saveSession(recovered);
                this.emitStructuredSnapshot(recovered);
              }
            });
          });
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
          resolve();
          setImmediate(() => {
            this.sendMessage(sessionId, "Plan approved. Proceed with the implementation.").catch((err) => {
              console.error("[WAND] Auto-continue after ExitPlanMode failed:", err);
            });
          });
          return;
        }

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
  private async runClaudeSdkStreaming(sessionId: string, session: SessionSnapshot, prompt: string): Promise<void> {
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
    // 思考深度：off → 显式禁用 thinking，其他 → 给一个固定 budget。
    // SDK 类型用驼峰 budgetTokens（API 层是 budget_tokens，SDK 内部已做转换）。
    const sdkThinkingBudget = thinkingEffortToSdkBudget(session.thinkingEffort);
    const sdkThinking: { type: "enabled"; budgetTokens: number } | { type: "disabled" } =
      sdkThinkingBudget > 0
        ? { type: "enabled", budgetTokens: sdkThinkingBudget }
        : { type: "disabled" };

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
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
      const current = this.sessions.get(sessionId);
      if (!current) return;
      this.emit({ type: "output", sessionId, data: buildIncrementalStructuredPayload(current, this.config.cardDefaults ?? {}) });
    };

    const scheduleEmit = (): void => {
      if (!emitTimer) emitTimer = setTimeout(flushEmit, STREAM_EMIT_DEBOUNCE_MS);
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
          block = { type: "tool_use", id: sb.id, name: sb.name, input };
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
      const current = this.sessions.get(sessionId);
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

    const queryHandle = sdkQuery({ prompt: singleShotPrompt(), options: sdkOptions });
    this.pendingSdkQueries.set(sessionId, queryHandle);

    try {
      for await (const msg of queryHandle as AsyncIterable<SDKMessage>) {
        if (abortController.signal.aborted) break;

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
        this.pendingSdkAbort.delete(sessionId);
        this.pendingSdkQueries.delete(sessionId);
        this.lastStreamSaveAt.delete(sessionId);
        if (emitTimer) clearTimeout(emitTimer);
        this.logger?.appendStructuredSpawn(sessionId, {
          kind: "claude-sdk-error",
          spawnedAt,
          closedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // Cleanup
    this.pendingSdkAbort.delete(sessionId);
    this.pendingSdkQueries.delete(sessionId);
    this.lastStreamSaveAt.delete(sessionId);
    if (emitTimer) clearTimeout(emitTimer);
    flushEmit();

    const current = this.sessions.get(sessionId);
    if (!current) throw new Error("Session removed during execution.");

    this.logger?.appendStructuredSpawn(sessionId, {
      kind: "claude-sdk-close",
      spawnedAt,
      closedAt: new Date().toISOString(),
      killedForAskUserQuestion,
      sessionId: turnState.sessionId,
    });

    const interruptedByUser = this.interruptedWith.has(sessionId);

    // Build final assistant turn
    const finalContent = this.compactContentBlocks([...turnState.blocks], turnState.result);
    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: finalContent,
      usage: turnState.usage,
    };
    const msgs = [...(current.messages ?? [])];
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && lastMsg.role === "assistant") msgs[msgs.length - 1] = assistantTurn;
    else msgs.push(assistantTurn);

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
      queuedMessages: interruptPrompt ? [] : current.queuedMessages,
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
    this.storage.saveSession(finished);
    this.emitStructuredSnapshot(finished);
    if (!keepRunning) this.emitStructuredSnapshot(finished, "ended");

    if (killedForAskUserQuestion) return;

    if (interruptPrompt) {
      this.interruptedWith.delete(sessionId);
      setImmediate(() => {
        this.sendMessage(sessionId, interruptPrompt).catch((err) => {
          console.error("[WAND] sdk interrupt-and-send failed:", err);
          const afterFail = this.sessions.get(sessionId);
          if (afterFail) {
            const recovered: SessionSnapshot = {
              ...afterFail,
              status: "idle",
              exitCode: 0,
              endedAt: new Date().toISOString(),
              structuredState: {
                ...(afterFail.structuredState as StructuredSessionState),
                inFlight: false,
                activeRequestId: null,
              },
            };
            this.sessions.set(sessionId, recovered);
            this.storage.saveSession(recovered);
            this.emitStructuredSnapshot(recovered);
          }
        });
      });
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
          input: this.normalizeToolInput(typedBlock.input),
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

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {};
    }
    return input as Record<string, unknown>;
  }

  private normalizeToolResultContent(content: unknown): string | Array<{ type: string; [key: string]: unknown }> {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.filter((item): item is { type: string; [key: string]: unknown } => !!item && typeof item === "object" && typeof (item as any).type === "string");
    }
    return typeof content === "undefined" || content === null ? "" : String(content);
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
    const blocks = this.extractCodexItemBlock(item, completed);
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
   *   file_change       → one tool_use per file, named Edit/Write/Bash by `kind`
   *                       (codex does NOT carry old_string/new_string in the
   *                       exec stream, only the path list; diff card body is
   *                       empty but the file row + status still render)
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
  private extractCodexItemBlock(item: Record<string, unknown>, completed: boolean): ContentBlock[] {
    const id = typeof item.id === "string" ? item.id : randomUUID();
    const type = typeof item.type === "string" ? item.type : "unknown";

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
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: "Bash",
          input: { command, status },
        }];
      }
      // codex 的 status 可能是 declined（sandbox 拒了命令）/ failed（执行失败）—
      // 这时 exit_code 经常是 null，光靠 exitCode !== 0 判 is_error 会漏。
      const isError = status === "failed" || status === "declined"
        || (typeof exitCode === "number" && exitCode !== 0);
      const fallbackText = status === "declined"
        ? "command declined by sandbox"
        : (exitCode === null ? "" : `exit_code: ${exitCode}`);
      return [{
        type: "tool_result",
        tool_use_id: id,
        content: aggregatedOutput || fallbackText,
        is_error: isError,
      }];
    }

    if (type === "file_change") {
      // 注意：codex exec stream 没有 old_string/new_string——只给 path + kind。
      // 这里每个 file 一个 sub-id（`${item.id}#${i}`），这样如果 codex 一次给多
      // 个文件，每个文件能独立成卡片 + 独立 tool_result 状态。
      const rawChanges = Array.isArray(item.changes) ? item.changes : [];
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      const isError = status === "failed";
      const blocks: ContentBlock[] = [];
      rawChanges.forEach((entry, idx) => {
        if (!entry || typeof entry !== "object") return;
        const change = entry as Record<string, unknown>;
        const path = typeof change.path === "string" ? change.path : "";
        const kind = typeof change.kind === "string" ? change.kind : "update";
        const subId = `${id}#${idx}`;
        let toolName: string;
        let input: Record<string, unknown>;
        if (kind === "add") {
          toolName = "Write";
          input = { file_path: path, content: "" };
        } else if (kind === "delete") {
          // 复用 Bash 终端卡，rm 语义直观
          toolName = "Bash";
          input = { command: `rm ${path}`, description: `delete ${path}`, status };
        } else {
          toolName = "Edit";
          input = { file_path: path, old_string: "", new_string: "" };
        }
        if (!completed) {
          blocks.push({ type: "tool_use", id: subId, name: toolName, input });
        } else {
          blocks.push({ type: "tool_use", id: subId, name: toolName, input });
          blocks.push({
            type: "tool_result",
            tool_use_id: subId,
            content: isError ? `file change failed: ${path}` : "",
            is_error: isError,
          });
        }
      });
      return blocks;
    }

    if (type === "mcp_tool_call") {
      const server = typeof item.server === "string" ? item.server : "mcp";
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      const args = item.arguments && typeof item.arguments === "object" ? item.arguments as Record<string, unknown> : {};
      const errObj = item.error && typeof item.error === "object" ? item.error as Record<string, unknown> : null;
      const status = typeof item.status === "string" ? item.status : completed ? "completed" : "in_progress";
      const isError = !!errObj || status === "failed";
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: `${server}__${tool}`,
          input: args,
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
      return [{
        type: "tool_result",
        tool_use_id: id,
        content: resultText,
        is_error: isError,
      }];
    }

    if (type === "web_search") {
      const query = typeof item.query === "string" ? item.query : "";
      if (!completed) {
        return [{
          type: "tool_use",
          id,
          name: "WebSearch",
          input: { query },
        }];
      }
      return [{
        type: "tool_result",
        tool_use_id: id,
        // codex 不在 exec 流里回 search 结果，这里给个占位让 UI 卡片完成态。
        content: query ? `query: ${query}` : "",
      }];
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
    provider: "claude -p" | "codex exec",
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
