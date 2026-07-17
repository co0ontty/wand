import type {
  ContentBlock,
  ConversationTurn,
  StructuredQuestion,
  StructuredTaskItem,
  ToolUseBlock,
} from "./types.js";

export const WAND_PROTOCOL_VERSION = 2;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

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
    const question = record(rawQuestion);
    if (!question) continue;
    const options = (arrayValue(question.options) ?? []).flatMap((rawOption, index) => {
      const option = record(rawOption);
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

function toolResultText(block: ContentBlock): string {
  if (block.type !== "tool_result") return "";
  if (typeof block.content === "string") return block.content;
  return block.content.map((part) => text(part.text) ?? "").join("");
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
      if (block.type === "tool_use" && ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList"].includes(block.name)) {
        targetId = block.id;
        if (block.name === "TodoWrite") latestTodoWrite = block;
      }
    }
  }

  if (latestTodoWrite) {
    const todos = arrayValue(latestTodoWrite.input.todos) ?? arrayValue(latestTodoWrite.input.plan) ?? [];
    const items = todos.flatMap((rawTodo, index): StructuredTaskItem[] => {
      const todo = record(rawTodo);
      if (!todo) return [];
      return [{
        id: text(todo.id) ?? String(index + 1),
        content: text(todo.content) ?? text(todo.subject) ?? "",
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
      if (block.name === "TaskCreate") {
        sawTaskTool = true;
        fallbackId++;
        const match = resultByToolId.get(block.id)?.match(/#([^\s]+)/);
        const id = match?.[1] ?? String(fallbackId);
        tasks.set(id, {
          id,
          content: text(block.input.subject) ?? text(block.input.description) ?? `Task #${id}`,
          status: "pending",
          ...(text(block.input.activeForm) ? { activeForm: text(block.input.activeForm) } : {}),
        });
      } else if (block.name === "TaskUpdate") {
        sawTaskTool = true;
        const id = String(block.input.taskId ?? "");
        if (!id) continue;
        const previous = tasks.get(id) ?? { id, content: `Task #${id}`, status: "pending" };
        tasks.set(id, {
          ...previous,
          ...(text(block.input.subject) ? { content: text(block.input.subject)! } : {}),
          ...(text(block.input.status) ? { status: text(block.input.status)! } : {}),
          ...(text(block.input.activeForm) ? { activeForm: text(block.input.activeForm) } : {}),
        });
      }
    }
  }
  return {
    items: sawTaskTool ? [...tasks.values()].filter((task) => task.status !== "deleted") : [],
    targetId,
  };
}

/**
 * Add Wand-owned semantics without mutating persisted provider blocks.
 * This is the external interface consumed by every client.
 */
export function enrichStructuredMessages(messages: ConversationTurn[]): ConversationTurn[] {
  const enriched = messages.map((turn) => ({
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
  return enriched;
}
