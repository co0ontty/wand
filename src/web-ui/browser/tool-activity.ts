import { isDecisionToolCall } from "../../decision-tool.js";

export type ToolActivityKind = "edit_file" | "read_file" | "run_command" | "other";

export interface ToolActivityCall<T> {
  block: T;
  index: number;
}

export interface ToolActivityEntry<T> {
  kind: ToolActivityKind;
  key: string;
  calls: Array<ToolActivityCall<T>>;
}

/** 一轮深度思考在段内的身份：第 ordinal 轮 / 共 total 轮。 */
export interface ThinkingRound<T> {
  call: ToolActivityCall<T>;
  ordinal: number;
  total: number;
}

/** 段内活跃条目：调用与思考轮次二选一，全段至多一个。 */
export type ActivityLiveRow<T> =
  | { kind: "call"; call: ToolActivityCall<T> }
  | { kind: "thinking"; round: ThinkingRound<T> };

type ActivityBlock = {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  occurredAt?: string;
  lastActivityAt?: string;
  input?: Record<string, unknown>;
  preview?: string;
  semantic?: { kind?: string };
  activity?: { kind?: string; label?: string; fileKey?: string; occurredAt?: string };
};

export const TOOL_ACTIVITY_KINDS: readonly ToolActivityKind[] =
  ["edit_file", "read_file", "run_command", "other"];

const PLAN_TOOL_NAMES = new Set(["Pi/todo", "TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

/** Planning is execution history, not an assistant reply. Keep its real data for
 * the existing progress owner and on-demand details; only project the Web label. */
export function isPlanTool(block: ActivityBlock): boolean {
  return block?.type === "tool_use" && (PLAN_TOOL_NAMES.has(block.name || "") || block.semantic?.kind === "task_list");
}

export function presentActivityBlock<T extends ActivityBlock>(block: T): T & ActivityBlock {
  if (!isPlanTool(block) || isDecisionToolCall(block)) return block;
  const input = block.input || {};
  const action = String(input.action || (block.name === "TaskCreate" ? "create"
    : block.name === "TaskUpdate" || block.name === "TodoWrite" ? "update" : "list"));
  const labels: Record<string, string> = { create: "新增待办", update: "更新待办", list: "查看待办", get: "查看待办", delete: "移除待办", clear: "清空待办" };
  const statuses: Record<string, string> = { pending: "待开始", in_progress: "进行中", completed: "已完成", deleted: "已移除" };
  const subject = typeof input.subject === "string" ? input.subject : typeof input.content === "string" ? input.content : "";
  const id = input.id ?? input.taskId;
  return { ...block,
    activity: { ...block.activity, kind: "other", label: labels[action] || "更新待办", occurredAt: block.occurredAt || block.activity?.occurredAt },
    preview: [subject || (id !== undefined ? `待办 #${id}` : ""), statuses[String(input.status)] || ""].filter(Boolean).join(" · "),
  };
}

/** Pure activity turns show their small menu directly, without a reply disclosure. */
export function isToolActivityOnly(source: ActivityBlock[], decisionIds?: ReadonlySet<string>): boolean {
  const blocks = source.map(presentActivityBlock);
  return !blocks.some(block => isDecisionToolCall(block) || block.type === "tool_use" && !!block.id && decisionIds?.has(block.id))
    && blocks.some(block => block.type === "thinking" || block.type === "tool_use" && !!block.activity)
    && blocks.every(block => block.type === "thinking" || block.type === "tool_result"
      || block.type === "tool_use" && !!block.activity
      || block.type === "text" && !block.text?.trim());
}

/** Source order is invocation order, including untimed legacy calls and thinking.
 * Distinct accesses to the same file stay distinct; retransmitted ids do not.
 * A reasoning block that never produced text is not an entry; the trailing one
 * stays because it may be the round still streaming. */
export function toolActivityTimeline<T extends ActivityBlock>(
  items: Array<ToolActivityCall<T>>,
): Array<ToolActivityCall<T>> {
  const seen = new Set<string>();
  const lastPosition = items.length - 1;
  return items.filter(({ block }, position) => {
    if (block.type === "thinking") {
      return String(block.thinking ?? "").trim() !== "" || position === lastPosition;
    }
    if (block.type !== "tool_use" || !block.activity || isDecisionToolCall(block)) return false;
    if (!block.id) return true;
    if (seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
}

/**
 * 一个思考块算不算一轮：空块只有在「它就是段尾」时才是正在进行的那一轮占位，
 * 其余空块是没产出过正文的轮次（provider 只发了边界事件），不占时间线也不占计数。
 */
function keepThinkingRound<T extends ActivityBlock>(item: ToolActivityCall<T>, lastPosition: number): boolean {
  if (item.block.type !== "thinking") return false;
  return String(item.block.thinking ?? "").trim() !== "" || item.index === lastPosition;
}

/** Each reasoning block is one round; rounds keep their arrival order identity. */
export function thinkingRounds<T extends ActivityBlock>(
  items: Array<ToolActivityCall<T>>,
): Array<ThinkingRound<T>> {
  const lastPosition = items.length - 1;
  const rounds = items.filter((item, position) =>
    item.block.type === "thinking" && (String(item.block.thinking ?? "").trim() !== "" || position === lastPosition));
  return rounds.map((call, index) => ({ call, ordinal: index + 1, total: rounds.length }));
}

/** A single round stays plain; only multiple rounds need the k/N position. */
export function thinkingRoundLabel(round: ThinkingRound<unknown> | undefined): string {
  if (!round) return "深度思考";
  return round.total > 1 ? `深度思考 ${round.ordinal}/${round.total}` : "深度思考";
}

/**
 * 段内当前活跃的条目：没回执的调用优先（它真在等外部结果），全部返回之后
 * 才是最后一轮思考。位置猜测会被按时间重排、待办不回执和跨轮续想骗到，
 * 摘要与时间线行共用这一份判定，全段因此只有一个 loading。
 */
export function activityLiveRow<T extends ActivityBlock>(
  items: Array<ToolActivityCall<T>>,
  pendingCallId: string | null,
  live: boolean,
): ActivityLiveRow<T> | null {
  if (!live) return null;
  if (pendingCallId) {
    const call = items.find(item => item.block.id === pendingCallId);
    if (call) return { kind: "call", call };
  }
  const round = thinkingRounds(items).at(-1);
  return round ? { kind: "thinking", round } : null;
}

/** Counts distinct files for edit/read and distinct calls for the other groups. */
export function groupToolActivities<T extends ActivityBlock>(
  items: Array<ToolActivityCall<T>>,
): Record<ToolActivityKind, Array<ToolActivityEntry<T>>> {
  const groups: Record<ToolActivityKind, Array<ToolActivityEntry<T>>> = {
    edit_file: [], read_file: [], run_command: [], other: [],
  };
  const seenIds = new Set<string>();
  const fileEntries = new Map<string, ToolActivityEntry<T>>();
  for (const [index, call] of items.entries()) {
    const block = call.block;
    if (block?.type !== "tool_use" || !block.activity || isDecisionToolCall(block)) continue;
    const id = String(block.id || "");
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);
    const kind: ToolActivityKind = TOOL_ACTIVITY_KINDS.includes(block.activity.kind as ToolActivityKind)
      ? block.activity.kind as ToolActivityKind : "other";
    const fileKey = (kind === "edit_file" || kind === "read_file")
      && typeof block.activity.fileKey === "string" ? block.activity.fileKey : "";
    const key = fileKey ? `${kind}:${fileKey}` : `${kind}:${id || index}`;
    let entry = fileKey ? fileEntries.get(key) : undefined;
    if (!entry) {
      entry = { kind, key, calls: [] };
      groups[kind].push(entry);
      if (fileKey) fileEntries.set(key, entry);
    }
    entry.calls.push(call);
  }
  return groups;
}

/** Return the newest real command event time; older histories may not carry one. */
export function latestCommandOccurredAt<T extends ActivityBlock>(
  entries: Array<ToolActivityEntry<T>>,
): string | null {
  let newest: string | null = null;
  let newestTime = -Infinity;
  for (const entry of entries) {
    for (const call of entry.calls) {
      const occurredAt = call.block.activity?.occurredAt;
      const time = typeof occurredAt === "string" ? Date.parse(occurredAt) : NaN;
      if (Number.isFinite(time) && time > newestTime) {
        newestTime = time;
        newest = occurredAt!;
      }
    }
  }
  return newest;
}

export function commandOccurredAt<T extends ActivityBlock>(
  entries: Array<ToolActivityEntry<T>>,
  toolId: string,
): string | null {
  for (const entry of entries) {
    for (const call of entry.calls) {
      if (call.block.id !== toolId) continue;
      const occurredAt = call.block.activity?.occurredAt;
      return typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt))
        ? occurredAt : null;
    }
  }
  return null;
}

export function formatActivityElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatThinkingElapsed(startedAt: string, lastActivityAt: string | undefined, now = Date.now()): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "";
  const elapsed = "思考 " + formatActivityElapsed(now - start);
  const last = Date.parse(lastActivityAt || "");
  return Number.isFinite(last) && now - last >= 60_000
    ? elapsed + " · " + formatActivityElapsed(now - last) + "无新进展"
    : elapsed;
}

export function currentToolActivity(
  messages: Array<{ role?: string; content?: unknown }>,
  lastUserTextIndex: number,
  toolResults: Record<string, unknown[]>,
): { latestAssistantIndex: number; pendingCommandId: string | null } {
  let latestAssistantIndex = -1;
  let pendingCommandId: string | null = null;
  for (let messageIndex = messages.length - 1;
    messageIndex >= Math.max(0, lastUserTextIndex); messageIndex--) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    if (latestAssistantIndex < 0) latestAssistantIndex = messageIndex;
    const blocks = Array.isArray(message.content) ? message.content as ActivityBlock[] : [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = presentActivityBlock(blocks[blockIndex]);
      if (block?.type !== "tool_use" || !block.activity || !block.id || isDecisionToolCall(block)) continue;
      if (!toolResults[block.id]?.length) {
        pendingCommandId = block.id;
        break;
      }
    }
    if (pendingCommandId) break;
  }
  return { latestAssistantIndex, pendingCommandId };
}
