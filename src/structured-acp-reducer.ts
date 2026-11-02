import type { ContentBlock, ConversationTurn, SessionSnapshot, ToolResultBlock, ToolUseBlock } from "./types.js";
import type { StructuredRunnerTurnState } from "./structured-runner.js";

/**
 * ACP `session/update` → Wand 的会话块。
 *
 * ACP 是「增量」协议：文本按 chunk 流式到达，工具调用先给 `tool_call` 再给
 * `tool_call_update`。Wand 的渲染面读的是 Claude 形状的块（text / thinking /
 * tool_use / tool_result），所以这里按 key 累积并重建整块列表，和 Claude CLI
 * reducer 保持同一套语义（同一 key 的内容是「替换」而不是「追加一条新消息」）。
 */

/** ACP 工具种类 → Wand 认识的原生工具名；认不出来就保留 agent 自己给的标题。 */
const ACP_TOOL_NAMES: Record<string, string> = {
  execute: "Bash",
  read: "Read",
  edit: "Edit",
  search: "Grep",
  fetch: "WebFetch",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const entry = asRecord(raw);
    if (!entry) continue;
    if (entry.type === "content") {
      const block = asRecord(entry.content);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "image") parts.push("[图片]");
      else if (block.type === "resource_link") parts.push(`[资源] ${getString(block.uri)}`);
      continue;
    }
    if (entry.type === "diff") {
      const path = getString(entry.path);
      const newText = typeof entry.newText === "string" ? entry.newText : "";
      parts.push([`修改文件：${path}`, newText].filter(Boolean).join("\n"));
      continue;
    }
    if (entry.type === "terminal") parts.push(`[终端] ${getString(entry.terminalId)}`);
  }
  return parts.join("\n").trim();
}

/** 把 ACP 的工具调用归一成 Wand 认识的原生工具名 + 原生输入字段。 */
function normalizeToolCall(
  update: Record<string, unknown>,
  locations: string[],
): { name: string; input: Record<string, unknown> } {
  const title = getString(update.title);
  const kind = getString(update.kind);
  const raw = asRecord(update.rawInput) ?? {};
  const fallback = locations[0] ?? title;
  const nativeName = getString(asRecord(asRecord(update._meta)?.qoder)?.toolName);
  const name = nativeName || getString(update.name) || ACP_TOOL_NAMES[kind] || title || "工具";
  const input: Record<string, unknown> = { ...raw };
  if (name === "Bash" && !getString(raw.command) && !getString(raw.cmd)) input.command = title;
  if ((name === "Read" || name === "Edit") && !getString(raw.file_path) && !getString(raw.path)) input.file_path = fallback;
  if (name === "Grep" && !getString(raw.pattern) && !getString(raw.query)) input.pattern = title;
  if (name === "WebFetch" && !getString(raw.url)) input.url = title;
  return { name, input };
}

/** 比对错误回显时忽略「[Error] 」这类前缀与空白差异，只比对实质文字。 */
function normalizeEchoText(text: string): string {
  return text.replace(/^\s*\[[^\]]{0,32}\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function toolLocations(update: Record<string, unknown>): string[] {
  const raw = update.locations;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => getString(asRecord(entry)?.path))
    .filter((path) => path.length > 0);
}

export interface AcpPromptResult {
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export class AcpTurnReducer {
  readonly state: StructuredRunnerTurnState;
  /** Agent 在本轮亲口说明的结束原因（`end_turn` / `cancelled` / …）。 */
  stopReason: string | null = null;
  /** 是否已经出现过可观察的产出（内容块或工具事件）。 */
  workObserved = false;
  private readonly entries = new Map<string, ContentBlock[]>();
  private readonly order: string[] = [];
  private readonly textByKey = new Map<string, string>();
  private readonly thoughtByKey = new Map<string, string>();
  private readonly toolCalls = new Map<string, ToolUseBlock>();
  private readonly toolResults = new Map<string, ToolResultBlock>();
  private lastTextKey: string | null = null;

  constructor(session: SessionSnapshot) {
    this.state = {
      blocks: [],
      result: "",
      sessionId: session.claudeSessionId ?? null,
      model: session.selectedModel && session.selectedModel !== "default" ? session.selectedModel : undefined,
      usage: undefined,
    };
  }

  /** 记录 agent 在 `initialize`/`session/new` 之后给出的原生会话 id。 */
  setSessionId(sessionId: string | null): void {
    if (sessionId) this.state.sessionId = sessionId;
  }

  applyQuestion(id: string, questions: unknown[]): boolean {
    const block: ToolUseBlock = {
      type: "tool_use",
      id,
      name: "AskUserQuestion",
      input: { questions },
    };
    this.toolCalls.set(id, block);
    this.workObserved = true;
    this.replace(`question:${id}`, [block]);
    return true;
  }

  resolveQuestion(id: string): boolean {
    if (!this.toolCalls.has(id)) return false;
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: id,
      content: "已回答。",
      is_error: false,
    };
    this.toolResults.set(id, block);
    this.replace(`result:${id}`, [block]);
    return true;
  }

  applyUpdate(update: Record<string, unknown>): boolean {
    const kind = getString(update.sessionUpdate);
    if (!kind) return false;
    if (kind === "agent_message_chunk") return this.appendText(update);
    if (kind === "agent_thought_chunk") return this.appendThought(update);
    if (kind === "tool_call") return this.upsertToolCall(update);
    if (kind === "tool_call_update") return this.upsertToolCallUpdate(update);
    if (kind === "plan") return this.upsertPlan(update);
    if (kind === "usage_update") return this.applyUsageUpdate(update);
    // available_commands_update / config_option_update / current_mode_update /
    // session_info_update / user_message_chunk / notice / compaction_* 不改写这一轮的转录。
    return false;
  }

  applyPromptResult(result: AcpPromptResult): boolean {
    this.stopReason = typeof result.stopReason === "string" ? result.stopReason : this.stopReason;
    const usage = result.usage;
    if (usage && (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number")) {
      this.state.usage = {
        ...this.state.usage,
        ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
      };
    }
    this.state.result = this.lastTextKey ? (this.textByKey.get(this.lastTextKey) ?? "").trim() : "";
    return true;
  }

  /**
   * 剔除 provider 把错误原文当成一条普通助手消息回显的块。
   *
   * Qoder 在额度/鉴权拒绝时会先发一个 `agent_message_chunk` 写出错误原文，再用同一个
   * 错误响应拒绝 `session/prompt`。那条回显不是模型产出：按错误原文逐字比对剔除（不做
   * 关键词匹配），这样「一行拒绝文案」不会被下游当成「本轮已经跑过」，降级链路不会断。
   * 只有当本轮所有文本都是这条错误回显时才剔除；有任何其它内容就保持原样。
   */
  dropErrorEcho(errorMessage: string): boolean {
    const echo = normalizeEchoText(errorMessage);
    if (!echo) return false;
    const textKeys = [...this.textByKey.keys()];
    if (textKeys.length === 0) return false;
    const allEcho = textKeys.every((key) => {
      const text = normalizeEchoText(this.textByKey.get(key) ?? "");
      return text.length > 0 && echo.includes(text);
    });
    if (!allEcho) return false;
    for (const key of textKeys) {
      this.textByKey.delete(key);
      this.entries.delete(key);
      const index = this.order.indexOf(key);
      if (index >= 0) this.order.splice(index, 1);
    }
    this.lastTextKey = null;
    this.state.result = "";
    this.state.blocks = this.order.flatMap((entry) => this.entries.get(entry) ?? []);
    // 工具调用/计划这类真实产出仍然算「跑过了」；回显本身不算。
    this.workObserved = this.order.length > 0;
    return true;
  }

  private appendText(update: Record<string, unknown>): boolean {
    const content = asRecord(update.content);
    if (!content || content.type !== "text" || typeof content.text !== "string" || !content.text) return false;
    const key = `text:${getString(update.messageId) || "stream"}`;
    const text = (this.textByKey.get(key) ?? "") + content.text;
    this.textByKey.set(key, text);
    this.lastTextKey = key;
    this.workObserved = true;
    this.replace(key, [{ type: "text", text }]);
    return true;
  }

  private appendThought(update: Record<string, unknown>): boolean {
    const content = asRecord(update.content);
    if (!content || content.type !== "text" || typeof content.text !== "string" || !content.text) return false;
    const key = `thought:${getString(update.messageId) || "stream"}`;
    const thinking = (this.thoughtByKey.get(key) ?? "") + content.text;
    this.thoughtByKey.set(key, thinking);
    this.workObserved = true;
    this.replace(key, [{ type: "thinking", thinking }]);
    return true;
  }

  private upsertToolCall(update: Record<string, unknown>): boolean {
    const toolCallId = getString(update.toolCallId);
    if (!toolCallId) return false;
    const normalized = normalizeToolCall(update, toolLocations(update));
    const previous = this.toolCalls.get(toolCallId);
    const block: ToolUseBlock = {
      type: "tool_use",
      id: toolCallId,
      name: normalized.name,
      ...(getString(update.title) && normalized.name !== getString(update.title)
        ? { description: getString(update.title) }
        : {}),
      input: previous && Object.keys(normalized.input).length === 0 ? previous.input : normalized.input,
    };
    this.toolCalls.set(toolCallId, block);
    this.workObserved = true;
    this.replace(`tool:${toolCallId}`, [block]);
    this.applyToolStatus(update, toolCallId);
    return true;
  }

  private upsertToolCallUpdate(update: Record<string, unknown>): boolean {
    const toolCallId = getString(update.toolCallId);
    if (!toolCallId) return false;
    const existing = this.toolCalls.get(toolCallId);
    const hasShape = !!getString(update.kind) || !!getString(update.title) || !!asRecord(update.rawInput);
    if (!existing && hasShape) return this.upsertToolCall(update);
    if (existing && (hasShape || Array.isArray(update.locations))) {
      const normalized = normalizeToolCall({ ...update, title: getString(update.title) || existing.description }, toolLocations(update));
      const block: ToolUseBlock = {
        ...existing,
        name: normalized.name,
        input: Object.keys(normalized.input).length > 0 ? normalized.input : existing.input,
      };
      this.toolCalls.set(toolCallId, block);
      this.replace(`tool:${toolCallId}`, [block]);
    }
    const changed = this.applyToolStatus(update, toolCallId);
    return changed || !!existing;
  }

  /** 工具状态/结果：`completed`/`failed` 才落成 tool_result，其它状态只更新 tool_use。 */
  private applyToolStatus(update: Record<string, unknown>, toolCallId: string): boolean {
    const status = getString(update.status);
    const text = toolContentText(update.content);
    if (status !== "completed" && status !== "failed") return false;
    if (!text && !this.toolCalls.has(toolCallId)) return false;
    const failed = status === "failed";
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolCallId,
      content: text || (failed ? "工具调用失败。" : "（无输出）"),
      is_error: failed,
    };
    this.toolResults.set(toolCallId, block);
    this.workObserved = true;
    this.replace(`result:${toolCallId}`, [block]);
    return true;
  }

  private upsertPlan(update: Record<string, unknown>): boolean {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const todos = entries.map((raw) => {
      const entry = asRecord(raw) ?? {};
      const status = getString(entry.status);
      const content = getString(entry.content);
      return {
        content,
        activeForm: content,
        status: status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending",
      };
    }).filter((todo) => todo.content.length > 0);
    if (todos.length === 0) return false;
    this.workObserved = true;
    this.replace("plan", [{
      type: "tool_use",
      id: "acp-plan",
      name: "TodoWrite",
      input: { todos },
    }]);
    return true;
  }

  private applyUsageUpdate(update: Record<string, unknown>): boolean {
    const used = typeof update.used === "number" ? update.used : null;
    const size = typeof update.size === "number" ? update.size : null;
    if (used === null || size === null || size <= 0) return false;
    const cost = asRecord(update.cost);
    const amount = cost && typeof cost.amount === "number" ? cost.amount : null;
    const currency = cost ? getString(cost.currency) : "";
    this.state.contextUsage = {
      usedTokens: used,
      windowTokens: size,
      percent: Math.max(0, Math.min(100, Math.round((used / size) * 1000) / 10)),
    };
    if (amount !== null && (!currency || currency.toUpperCase() === "USD")) {
      this.state.usage = { ...this.state.usage, totalCostUsd: amount } as ConversationTurn["usage"];
    }
    return true;
  }

  private replace(key: string, blocks: ContentBlock[]): void {
    if (!this.entries.has(key)) this.order.push(key);
    this.entries.set(key, blocks);
    this.state.blocks = this.order.flatMap((entry) => this.entries.get(entry) ?? []);
  }
}
