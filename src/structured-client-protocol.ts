import { asRecord, isStructuredImagePart } from "./structured-content.js";
import type {
  ContentBlock,
  ConversationTurn,
  StructuredQuestion,
  StructuredTaskItem,
  SubagentMeta,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export const WAND_PROTOCOL_VERSION = 2;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trimStart().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function questionsFromInput(input: Record<string, unknown>): StructuredQuestion[] {
  const rawQuestions = arrayValue(input.questions) ?? [];
  const questions: StructuredQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    const question = asRecord(rawQuestion);
    if (!question) continue;
    const options = (arrayValue(question.options) ?? []).flatMap((rawOption, index) => {
      const option = asRecord(rawOption);
      if (!option) return [];
      return [{
        label: text(option.label) ?? `选项 ${index + 1}`,
        ...(text(option.description) ? { description: text(option.description) } : {}),
      }];
    });
    if (options.length === 0) continue;
    questions.push({
      question: text(question.question) ?? "",
      ...(text(question.header) ? { header: text(question.header) } : {}),
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** 派发子 Agent 的工具名：Claude Code 的 Task/Agent，以及 Wand pi 扩展的 subagent。 */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);
const PI_SUBAGENT_TOOL_NAME = "Pi/subagent";
/** pi 的待办扩展工具，经 `piToolName` 映射后带 `Pi/` 前缀。 */
const PI_TODO_TOOL_NAME = "Pi/todo";

/**
 * 历史 turn / 非 Claude provider 的子 Agent 工具调用没有 `__subagent` 盖章，
 * 按调用参数现场补一份，让「子 Agent」面板在所有端都拿得到同一份分组。
 *
 * 只认一次真正的派发：Claude 的 Task/Agent（`subagent_type` 可省），
 * pi 扩展的 `Pi/subagent` 必须带 `agent`，避免把管理类调用误当子任务。
 */
function deriveSubagentMeta(block: ToolUseBlock): SubagentMeta | null {
  const existing = block.__subagent;
  if (existing?.taskId) return existing;
  const input = asRecord(block.input) ?? {};
  if (block.name === PI_SUBAGENT_TOOL_NAME) {
    const agent = text(input.agent);
    const task = text(input.task);
    if (!agent && !task) return null;
    return {
      taskId: block.id,
      ...(agent ? { agentType: agent } : {}),
      ...(task ? { taskDescription: task } : {}),
    };
  }
  const agentType = text(input.subagent_type);
  // Claude 的 Task/Agent 允许省 `subagent_type`；其他工具只有在真给了 `subagent_type` 时才算派发。
  if (!SUBAGENT_TOOL_NAMES.has(block.name) && !agentType) return null;
  const description = text(input.description);
  return {
    taskId: block.id,
    ...(agentType ? { agentType } : {}),
    ...(description ? { taskDescription: description } : {}),
  };
}

/**
 * 给没有盖章的子 Agent 调用打上 `__subagent`：派发用的 tool_use 自己带一份，
 * 对应的 tool_result（`tool_use_id` 命中 taskId）带同一份，客户端才好判定完成态。
 */
function stampDerivedSubagents(messages: ConversationTurn[]): ConversationTurn[] {
  const byTaskId = new Map<string, SubagentMeta>();
  for (const turn of messages) {
    for (const block of turn.content) {
      if (block.type !== "tool_use") continue;
      const meta = deriveSubagentMeta(block);
      if (meta) byTaskId.set(meta.taskId, meta);
    }
  }
  if (byTaskId.size === 0) return messages;
  return messages.map((turn) => ({
    ...turn,
    content: turn.content.map((block): ContentBlock => {
      if (block.__subagent) return block;
      if (block.type === "tool_use") {
        const meta = byTaskId.get(block.id);
        return meta ? { ...block, __subagent: meta } : block;
      }
      if (block.type === "tool_result") {
        const meta = byTaskId.get(block.tool_use_id);
        return meta ? { ...block, __subagent: meta } : block;
      }
      return block;
    }),
  }));
}

function toolResultText(block: ContentBlock): string {
  if (block.type !== "tool_result") return "";
  if (typeof block.content === "string") return block.content;
  return block.content.map((part) => text(part.text) ?? "").join("");
}

const TASK_LIST_TOOL_NAMES = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", PI_TODO_TOOL_NAME];

function piTodoAction(input: Record<string, unknown>): string {
  return text(input.action) ?? "";
}

function tasksFromSegment(messages: ConversationTurn[], start: number, end: number): {
  items: StructuredTaskItem[];
  targetId: string | null;
} {
  let latestTodoWrite: ToolUseBlock | null = null;
  let targetId: string | null = null;
  const resultByToolId = new Map<string, string>();
  for (let i = start; i < end; i++) {
    for (const block of messages[i]?.content ?? []) {
      if (block.type === "tool_result") resultByToolId.set(block.tool_use_id, toolResultText(block));
      if (block.type === "tool_use" && TASK_LIST_TOOL_NAMES.includes(block.name)) {
        targetId = block.id;
        if (block.name === "TodoWrite") latestTodoWrite = block;
      }
    }
  }

  if (latestTodoWrite) {
    const todos = arrayValue(latestTodoWrite.input.todos) ?? arrayValue(latestTodoWrite.input.plan) ?? [];
    const items = todos.flatMap((rawTodo, index): StructuredTaskItem[] => {
      const todo = asRecord(rawTodo);
      if (!todo) return [];
      return [{
        id: text(todo.id) ?? String(index + 1),
        content: text(todo.content) ?? text(todo.subject) ?? text(todo.description) ?? "",
        status: text(todo.status) ?? "pending",
        ...(text(todo.activeForm) ? { activeForm: text(todo.activeForm) } : {}),
      }];
    });
    return { items, targetId: latestTodoWrite.id };
  }

  const tasks = new Map<string, StructuredTaskItem>();
  let fallbackId = 0;
  let sawTaskTool = false;
  for (let i = start; i < end; i++) {
    for (const block of messages[i]?.content ?? []) {
      if (block.type !== "tool_use") continue;
      // pi 的待办工具把增删改合成一条 call，靠 `action` 区分，且主键是 `id` 而非 `taskId`。
      const piAction = block.name === PI_TODO_TOOL_NAME ? piTodoAction(block.input) : null;
      const isCreate = block.name === "TaskCreate" || piAction === "create";
      const isUpdate = block.name === "TaskUpdate"
        || (piAction !== null && piAction !== "list" && piAction !== "get");
      if (!isCreate && !isUpdate) continue;
      if (piAction === "clear") {
        sawTaskTool = true;
        tasks.clear();
        continue;
      }
      const rawId = isCreate ? "" : String(block.input.taskId ?? block.input.id ?? "");
      if (!isCreate && !rawId) continue;
      sawTaskTool = true;
      let id: string;
      if (isCreate) {
        fallbackId++;
        // 结果文本里才有分配到的 id：Claude「Task #7 created …」/ pi「Created #1: …」。
        id = resultByToolId.get(block.id)?.match(/#([^\s:,]+)/)?.[1] ?? String(fallbackId);
      } else {
        id = rawId;
      }
      const content = text(block.input.subject) ?? text(block.input.description);
      const status = text(block.input.status);
      const activeForm = text(block.input.activeForm);
      const deleted = piAction === "delete" || status === "deleted";
      tasks.set(id, {
        ...tasks.get(id) ?? { id, content: content ?? `Task #${id}`, status: "pending" },
        ...(content ? { content } : {}),
        ...(status ? { status } : {}),
        ...(deleted ? { status: "deleted" } : {}),
        ...(activeForm ? { activeForm } : {}),
      });
    }
  }
  return {
    items: sawTaskTool ? [...tasks.values()].filter((task) => task.status !== "deleted") : [],
    targetId,
  };
}

/**
 * 把 tool_result 里的内联 base64 图片换成「按会话取图」的 URL。
 *
 * 为什么不能把 base64 直接下发：读一张截图动辄 1–3MB，base64 后更大，会撑爆移动端
 * 单帧上限（iOS 默认 1MiB）导致反复断连；而且同一张图在每条快照里重复传。换成 URL
 * 后各端用同一套带鉴权的取图通道按需加载（Web 走 <img>，原生走各自 ImageLoader）。
 * source 本来就是 url 的图片不动，保持幂等。
 */
function rewriteInlineToolImageUrls(messages: ConversationTurn[], sessionId: string): ConversationTurn[] {
  return messages.map((turn) => {
    let turnChanged = false;
    const content = turn.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      let imageIndex = -1;
      let blockChanged = false;
      const parts = block.content.map((part) => {
        if (!isStructuredImagePart(part)) return part;
        imageIndex += 1;
        const source = asRecord((part as { source?: unknown }).source);
        if (source?.type !== "base64" || typeof source.data !== "string") return part;
        blockChanged = true;
        return {
          type: "image",
          source: {
            type: "url",
            url: `/api/sessions/${encodeURIComponent(sessionId)}/tool-images/${encodeURIComponent(block.tool_use_id)}/${imageIndex}`,
            ...(typeof source.media_type === "string" ? { media_type: source.media_type } : {}),
          },
        };
      });
      if (!blockChanged) return block;
      turnChanged = true;
      return { ...block, content: parts } as ToolResultBlock;
    });
    return turnChanged ? { ...turn, content } : turn;
  });
}

/**
 * Add Wand-owned semantics without mutating persisted provider blocks.
 * This is the external interface consumed by every client.
 *
 * 传 sessionId 时额外把内联图片改写成取图 URL（见 rewriteInlineToolImageUrls）。
 */
export function enrichStructuredMessages(messages: ConversationTurn[], sessionId?: string): ConversationTurn[] {
  const enriched = stampDerivedSubagents(messages).map((turn) => ({
    ...turn,
    content: turn.content.map((block) => {
      if (block.type !== "tool_use" || block.name !== "AskUserQuestion") return block;
      const questions = questionsFromInput(block.input);
      return questions.length > 0
        ? { ...block, semantic: { kind: "question_request" as const, questions } }
        : block;
    }),
  }));

  let segmentStart = 0;
  for (let i = 0; i <= enriched.length; i++) {
    const startsNextSegment = i === enriched.length
      || (i > segmentStart && enriched[i]?.role === "user"
        && enriched[i].content.some((block) => block.type === "text"));
    if (!startsNextSegment) continue;
    const { items, targetId } = tasksFromSegment(enriched, segmentStart, i);
    if (targetId && items.length > 0) {
      for (let turnIndex = i - 1; turnIndex >= segmentStart; turnIndex--) {
        const blockIndex = enriched[turnIndex].content.findIndex(
          (block) => block.type === "tool_use" && block.id === targetId,
        );
        if (blockIndex < 0) continue;
        const block = enriched[turnIndex].content[blockIndex];
        if (block.type === "tool_use") {
          enriched[turnIndex].content[blockIndex] = {
            ...block,
            semantic: { kind: "task_list", items },
          };
        }
        break;
      }
    }
    segmentStart = i;
  }
  return sessionId ? rewriteInlineToolImageUrls(enriched, sessionId) : enriched;
}
