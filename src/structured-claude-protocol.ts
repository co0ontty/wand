import { normalizeStructuredToolResultContent } from "./structured-content.js";
import type { ContentBlock, ConversationTurn, SessionSnapshot, SubagentMeta } from "./types.js";
import type { StructuredRunnerTurnState } from "./structured-runner.js";

export type TaskMetaMap = Map<string, { agentType?: string; description?: string }>;

export function captureTaskMeta(blocks: ContentBlock[], registry: TaskMetaMap): void {
  for (const block of blocks) {
    if (block.type !== "tool_use" || registry.has(block.id)) continue;
    const input = block.input ?? {};
    const agentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
    if (!agentType && block.name !== "Task" && block.name !== "Agent") continue;
    const description = typeof input.description === "string" ? input.description : undefined;
    registry.set(block.id, { agentType, description });
  }
}

export function tagSubagentBlocks(
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

export function stampSelfTask(blocks: ContentBlock[], registry: TaskMetaMap): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== "tool_use" || block.__subagent) return block;
    const meta = registry.get(block.id);
    if (!meta && block.name !== "Task" && block.name !== "Agent") return block;
    const stamp: SubagentMeta = {
      taskId: block.id,
      ...(meta?.agentType ? { agentType: meta.agentType } : {}),
      ...(meta?.description ? { taskDescription: meta.description } : {}),
    };
    return { ...block, __subagent: stamp } as ContentBlock;
  });
}

export function stampParentTaskResults(blocks: ContentBlock[], registry: TaskMetaMap): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type !== "tool_result" || block.__subagent) return block;
    const meta = registry.get(block.tool_use_id);
    if (!meta) return block;
    const stamp: SubagentMeta = {
      taskId: block.tool_use_id,
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
      ...(meta.description ? { taskDescription: meta.description } : {}),
    };
    return { ...block, __subagent: stamp } as ContentBlock;
  });
}

export function normalizeClaudeToolInput(name: unknown, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const field = name === "TodoWrite" ? "todos" : name === "AskUserQuestion" ? "questions" : undefined;
  if (field && typeof record[field] === "string") {
    try {
      const parsed = JSON.parse(record[field] as string);
      if (Array.isArray(parsed)) record[field] = parsed;
    } catch { /* Preserve malformed provider data verbatim. */ }
  }
  if (name === "TodoWrite" && Array.isArray(record.todos)) {
    record.todos = record.todos.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const todo = item as Record<string, unknown>;
      return typeof todo.content !== "string" && typeof todo.description === "string"
        ? { ...todo, content: todo.description }
        : item;
    });
  }
  return record;
}

function extractClaudeUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
  if (!source || !source.usage || typeof source.usage !== "object") return undefined;
  const usage = source.usage as Record<string, unknown>;
  const value = {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    cacheReadInputTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
    cacheCreationInputTokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined,
    totalCostUsd: typeof source.total_cost_usd === "number" ? source.total_cost_usd : undefined,
  };
  return Object.values(value).every((entry) => entry === undefined) ? undefined : value;
}

export function extractClaudeModelName(modelUsage: Record<string, unknown> | undefined): string | undefined {
  return modelUsage ? Object.keys(modelUsage)[0] : undefined;
}

export function extractClaudeAssistantMessage(message: Record<string, unknown>): {
  content: ContentBlock[];
  usage?: ConversationTurn["usage"];
} {
  const rawContent = Array.isArray(message.content) ? message.content : [];
  const content: ContentBlock[] = [];
  for (const rawBlock of rawContent) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      content.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        description: typeof block.description === "string" ? block.description : undefined,
        input: normalizeClaudeToolInput(block.name, block.input),
      });
    }
  }
  return { content, usage: extractClaudeUsage({ usage: message.usage }) };
}

interface ClaudeCliTurnState extends StructuredRunnerTurnState {
  sessionId: string | null;
}

export class ClaudeCliProtocolReducer {
  readonly state: ClaudeCliTurnState;
  askUserQuestionDetected = false;
  /** 原生 result 错误或系统强停子代理的说明，作为这一轮的主错误。 */
  errorText: string | null = null;
  /** 协议里出现过带 is_error 的 result 事件；没有本轮助手内容时才是可降级的执行前拒绝。 */
  errorResultObserved = false;
  /** 本轮真正跑出来的助手/工具内容，错误回显不算。 */
  assistantWorkObserved = false;
  private readonly blocksByKey = new Map<string, ContentBlock[]>();
  private readonly keyOrder: string[] = [];
  private readonly taskMetaRegistry: TaskMetaMap = new Map();
  private toolResultSequence = 0;
  private readonly qoder: boolean;
  private readonly childResultIds = new Set<string>();

  constructor(session: SessionSnapshot) {
    this.qoder = session.provider === "qoder" || session.runner === "qoder-cli-print";
    // A notification may resume a child dispatched in a previous CLI turn.
    // Seed only recognized dispatches, not arbitrary background shell tasks.
    if (this.qoder) {
      for (const turn of session.messages ?? []) captureTaskMeta(turn.content, this.taskMetaRegistry);
    }
    this.state = { blocks: [], result: "", sessionId: session.claudeSessionId, model: undefined, usage: undefined };
  }

  apply(parsed: unknown, managed: boolean): boolean {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const event = parsed as Record<string, unknown>;
    if (typeof event.session_id === "string" && event.session_id) this.state.sessionId = event.session_id;

    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      const message = event.message as Record<string, unknown>;
      const extracted = extractClaudeAssistantMessage(message);
      const key = typeof message.id === "string" && message.id
        ? `assistant:${message.id}`
        : `assistant:anon:${this.keyOrder.length}`;
      const parentId = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id
        ? event.parent_tool_use_id
        : null;
      if (parentId === null) captureTaskMeta(extracted.content, this.taskMetaRegistry);
      const stamped = parentId === null
        ? stampSelfTask(extracted.content, this.taskMetaRegistry)
        : tagSubagentBlocks(extracted.content, parentId, this.taskMetaRegistry);
      if (stamped.length > 0) {
        this.assistantWorkObserved = true;
        this.upsertBlocks(key, stamped);
      }
      if (!managed && extracted.content.some((block) => block.type === "tool_use" && block.name === "AskUserQuestion")) {
        this.askUserQuestionDetected = true;
      }
      return true;
    }

    if (event.type === "user" && event.message && typeof event.message === "object") {
      const content = (event.message as Record<string, unknown>).content;
      if (!Array.isArray(content)) return true;
      const collected: ContentBlock[] = [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type !== "tool_result") continue;
        collected.push({
          type: "tool_result",
          tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: normalizeStructuredToolResultContent(block.content),
          is_error: block.is_error === true,
        });
      }
      const parentId = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id
        ? event.parent_tool_use_id
        : null;
      if (this.qoder && parentId === null) {
        const nativeResult = event.tool_use_result as { isAsync?: boolean } | undefined;
        for (const block of collected) {
          if (block.type !== "tool_result") continue;
          const launch = nativeResult?.isAsync === true || (typeof block.content === "string"
            && block.content.trim().startsWith("Async agent launched successfully.\n"));
          if (!launch) this.childResultIds.add(block.tool_use_id);
        }
      }
      const visible = this.qoder ? collected.filter((block) => {
        if (block.type !== "tool_result") return true;
        const launch = typeof block.content === "string"
          && block.content.trim().startsWith("Async agent launched successfully.\n");
        return !launch || (!this.blocksByKey.has(`qoder-task-notification:${block.tool_use_id}`)
          && !this.childResultIds.has(block.tool_use_id));
      }) : collected;
      const stamped = parentId === null
        ? stampParentTaskResults(visible, this.taskMetaRegistry)
        : tagSubagentBlocks(visible, parentId, this.taskMetaRegistry);
      if (stamped.length > 0) {
        this.assistantWorkObserved = true;
        this.upsertBlocks(`tool_result:${this.toolResultSequence++}`, stamped);
      }
      return true;
    }

    // Qoder's native lifecycle notification is independent of the Agent launch
    // receipt and of the parent's prose. It can arrive in a later CLI turn, whose
    // reducer has never seen the dispatch. The native tool_use_id is the exact
    // correlation key; task_id, filenames and agent names are not substitutes.
    if (this.qoder && event.type === "system" && event.subtype === "task_notification") {
      const toolUseId = typeof event.tool_use_id === "string" ? event.tool_use_id.trim() : "";
      if (!toolUseId || !this.taskMetaRegistry.has(toolUseId)
        || (event.status !== "completed" && event.status !== "failed")
        || this.childResultIds.has(toolUseId)) return false;
      const key = `qoder-task-notification:${toolUseId}`;
      if (this.blocksByKey.has(key)) return false;
      const failed = event.status === "failed";
      const summary = typeof event.summary === "string" ? event.summary.trim() : "";
      const meta = this.taskMetaRegistry.get(toolUseId);
      // The observed protocol supplies a summary, not the child's result body.
      // Do not read arbitrary output_file paths or copy a parent's answer here.
      const content = [
        failed ? "原生子任务通知：执行失败。" : "原生子任务通知：已完成。",
        ...(summary ? [`原生摘要：${summary}`] : []),
        "此通知未提供结果正文；以上是运行状态通知，不是子任务的最终产出。",
      ].join("\n\n");
      this.assistantWorkObserved = true;
      this.upsertBlocks(key, [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: failed,
        __subagent: {
          taskId: toolUseId,
          ...(meta?.agentType ? { agentType: meta.agentType } : {}),
          ...(meta?.description ? { taskDescription: meta.description } : {}),
        },
      }]);
      return true;
    }

    if (event.type === "result") {
      if (typeof event.result === "string") this.state.result = event.result.trim();
      if (event.is_error === true) {
        this.errorResultObserved = true;
        const detail = this.state.result
          || (typeof event.subtype === "string" && event.subtype && event.subtype !== "success"
            ? `Claude 以 ${event.subtype} 结束，未产生任何输出。` : "");
        if (detail) this.errorText = detail;
      } else if (!this.qoder) {
        // Claude 2.1.296 can report success / exit 0 after its background-wait
        // ceiling has killed children. Use the native execution facts, never
        // the parent's prose or stderr keywords, and never classify this as an
        // upstream rejection that would authorize replay of already-run work.
        const stats = event.subagent_stats as { killed?: { system?: unknown } } | undefined;
        const killed = stats?.killed?.system;
        if (typeof killed === "number" && Number.isSafeInteger(killed) && killed > 0 && !this.errorText) {
          this.errorText = `Claude Code 被系统停止了 ${killed} 个子代理，任务未完整完成；请检查已有改动后再续接，不要自动重跑。`;
        }
      }
      this.state.model = extractClaudeModelName(
        event.modelUsage && typeof event.modelUsage === "object"
          ? event.modelUsage as Record<string, unknown>
          : undefined,
      ) ?? this.state.model;
      this.state.usage = extractClaudeUsage(event) ?? this.state.usage;
      return true;
    }
    return typeof event.session_id === "string";
  }

  private blockVolume(block: ContentBlock | undefined): number {
    if (!block) return 0;
    let total = 0;
    if (block.type === "text") total += block.text.length;
    if (block.type === "thinking") total += block.thinking.length;
    if (block.type === "tool_result" && typeof block.content === "string") total += block.content.length;
    if (block.type === "tool_use") {
      try { total += JSON.stringify(block.input).length; } catch { /* best effort */ }
    }
    return total;
  }

  private upsertBlocks(key: string, blocks: ContentBlock[]): void {
    const previous = this.blocksByKey.get(key);
    if (!previous) {
      this.keyOrder.push(key);
      this.blocksByKey.set(key, blocks);
      this.rebuildBlocks();
      return;
    }
    const cumulative = blocks.length >= previous.length
      && previous.every((block, index) => !blocks[index] || block.type === blocks[index].type);
    if (cumulative) {
      this.blocksByKey.set(key, blocks.map((block, index) =>
        this.blockVolume(block) >= this.blockVolume(previous[index]) ? block : previous[index],
      ));
      this.rebuildBlocks();
      return;
    }
    const merged = [...previous];
    for (const block of blocks) {
      if (block.type === "tool_use") {
        const index = merged.findIndex((entry) => entry.type === "tool_use" && entry.id === block.id);
        if (index < 0) merged.push(block);
        else if (this.blockVolume(block) >= this.blockVolume(merged[index])) merged[index] = block;
      } else if (block.type === "tool_result") {
        merged.push(block);
      } else {
        const duplicate = block.type === "text"
          ? merged.some((entry) => entry.type === "text" && entry.text === block.text)
          : block.type === "thinking" && merged.some((entry) => entry.type === "thinking" && entry.thinking === block.thinking);
        if (!duplicate) merged.push(block);
      }
    }
    this.blocksByKey.set(key, merged);
    this.rebuildBlocks();
  }

  private rebuildBlocks(): void {
    this.state.blocks = this.keyOrder.flatMap((key) => this.blocksByKey.get(key) ?? []);
  }
}
