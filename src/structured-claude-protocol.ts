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
  return record;
}

export function extractClaudeUsage(source: Record<string, unknown> | undefined): ConversationTurn["usage"] {
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
  private readonly blocksByKey = new Map<string, ContentBlock[]>();
  private readonly keyOrder: string[] = [];
  private readonly taskMetaRegistry: TaskMetaMap = new Map();
  private toolResultSequence = 0;

  constructor(session: SessionSnapshot) {
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
      if (stamped.length > 0) this.upsertBlocks(key, stamped);
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
      const stamped = parentId === null
        ? stampParentTaskResults(collected, this.taskMetaRegistry)
        : tagSubagentBlocks(collected, parentId, this.taskMetaRegistry);
      if (stamped.length > 0) this.upsertBlocks(`tool_result:${this.toolResultSequence++}`, stamped);
      return true;
    }

    if (event.type === "result") {
      if (typeof event.result === "string") this.state.result = event.result.trim();
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
          : merged.some((entry) => entry.type === "thinking" && entry.thinking === block.thinking);
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
