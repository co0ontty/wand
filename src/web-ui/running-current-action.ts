import type { ConversationTurn, ToolUseBlock } from "../types.js";
import type { RunningActivityShape } from "./running-activity.js";

export interface CurrentRunningAction {
  readonly kind: "tool" | "output" | "thinking" | "waiting";
  readonly label: string;
  readonly toolId?: string;
}

/** A tool name is an identifier, never a command/input/description excerpt. */
function toolLabel(tool: ToolUseBlock): string {
  const name = /^[\p{L}\p{N}_.:-]{1,64}$/u.test(tool.name) ? tool.name : "工具调用";
  switch (tool.activity?.kind) {
    case "read_file": return `读取文件 · ${name}`;
    case "edit_file": return `修改文件 · ${name}`;
    case "run_command": return `运行命令 · ${name}`;
    default: return name;
  }
}

/**
 * Only inspect one source session's current request. Missing request/time evidence
 * falls back to generic execution; an old unfinished tool is not current activity.
 * Text contents and tool arguments never participate in phase classification.
 */
export function currentRunningAction(source: RunningActivityShape): CurrentRunningAction | null {
  if (source.archived || ["failed", "stopped", "done", "exited"].includes(source.status ?? "")
    || !(source.structuredState?.inFlight || source.ptyRunning)) return null;
  const messages = source.messages ?? [];
  const request = source.structuredState?.activeRequestId;
  const started = Date.parse(source.structuredState?.turnStartedAt ?? source.turnStartedAt ?? "");
  let start = messages.length - 1;
  while (start >= 0 && !(messages[start]!.role === "user"
    && (messages[start]!.content ?? []).some(block => block.type === "text" && !block.__subagent && block.text.trim()))) start--;
  const user = messages[start];
  if (request && user?.requestId && user.requestId !== request) return null;
  const sameRequest = Boolean(request && user?.requestId === request);
  const isCurrent = (turn: ConversationTurn): boolean => {
    if (turn.author?.sessionId && turn.author.sessionId !== source.id) return false;
    if (request && turn.requestId) return turn.requestId === request;
    if (sameRequest) return true;
    const created = Date.parse(turn.createdAt ?? "");
    return Number.isFinite(started) && Number.isFinite(created) && created >= started;
  };
  const pending = new Map<string, ToolUseBlock>();
  const completed = new Set<string>();
  let latest: CurrentRunningAction | null = null;
  for (let index = start + 1; index < messages.length; index++) {
    const turn = messages[index]!;
    if (!isCurrent(turn)) continue;
    for (const block of turn.content ?? []) {
      if (block.__subagent) continue;
      if (block.type === "tool_result") {
        completed.add(block.tool_use_id);
        latest = null;
      }
      if (turn.role !== "assistant") continue;
      // completedAt ends the message stream, not the invoked tool. Only its
      // paired result retires a tool or a question awaiting the user.
      if (block.type === "tool_use") { pending.set(block.id, block); latest = null; }
      else if (!turn.completedAt && block.type === "text" && block.text.trim()) latest = { kind: "output", label: "正在输出" };
      else if (!turn.completedAt && block.type === "thinking") latest = { kind: "thinking", label: "正在思考" };
    }
  }
  const tool = [...pending.values()].reverse().find(block => !completed.has(block.id));
  if (tool?.semantic?.kind === "question_request" || tool?.name === "AskUserQuestion") {
    return { kind: "waiting", toolId: tool.id, label: "等待你的输入" };
  }
  return tool ? { kind: "tool", toolId: tool.id, label: toolLabel(tool) } : latest;
}
