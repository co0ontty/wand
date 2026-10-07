import type { ConversationTurn } from "../../../types.js";

/**
 * 「还跟着最新一条」的距底阈值：外层群聊列表、live 卡片与 IM 会话恢复共用这一个数，
 * 免得三处阈值漂到不同值。
 */
export const CONVERSATION_TAIL_PX = 24;

/**
 * 会话恢复位置的存档口径（`conversationUi.scrolls` 的取值）：
 * 非负数是离开时的像素位置；本哨兵表示「离开时本来就贴底」，恢复时按当期内容高度重新贴底。
 * 分这两种是为了让离开期间到达的新消息把人留在底部，而不是停在离底还差一截的旧像素处。
 */
export const CONVERSATION_SCROLL_FOLLOW_TAIL = -1;

interface ScrollBox { scrollTop: number; scrollHeight: number; clientHeight: number }

/** 读取存档位置：没记录过、哨兵或脏数据都返回 undefined，调用方按「贴底」处理。 */
export function storedConversationScroll(saved: number | undefined): number | undefined {
  return typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : undefined;
}

/** 写档：贴底存哨兵，否则存像素位置。 */
export function conversationScrollRecord(scroll: ScrollBox): number {
  return scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight) <= CONVERSATION_TAIL_PX
    ? CONVERSATION_SCROLL_FOLLOW_TAIL : scroll.scrollTop;
}

/** Presentation only: a recorded user turn means accepted, never read by a recipient. */
export function conversationMessageKey(turn: ConversationTurn, index: number): string {
  return turn.messageId ?? `${turn.requestId ?? ""}:${turn.role}:${turn.createdAt ?? ""}:${turn.author?.id ?? ""}:${index}`;
}

export function conversationDay(iso?: string): string {
  const date = new Date(iso ?? "");
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }) : "";
}

export function conversationClock(iso?: string): string {
  const date = new Date(iso ?? "");
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function joinsConversationBubble(previous: ConversationTurn | undefined, next: ConversationTurn | undefined): boolean {
  if (!previous || !next || previous.notice || next.notice || previous.role !== next.role) return false;
  if (previous.role !== "user" && (!previous.author?.id || previous.author.id !== next.author?.id)) return false;
  if (previous.conversationTarget?.runId !== next.conversationTarget?.runId) return false;
  const gap = Date.parse(next.createdAt ?? "") - Date.parse(previous.createdAt ?? "");
  return gap >= 0 && gap < 5 * 60_000 && conversationDay(previous.createdAt) === conversationDay(next.createdAt);
}

/** Only an overlapping, ordered tail can qualify as new; history, edits and scope switches cannot. */
export function appendedConversationKeys(previous: readonly string[] | null, next: readonly string[]): string[] {
  if (!previous) return [];
  if (!previous.length) return [...next];
  const end = next.indexOf(previous[previous.length - 1]!);
  if (end < 0) return [];
  const overlap = Math.min(end + 1, previous.length);
  if (!previous.slice(-overlap).every((key, index) => key === next[end + 1 - overlap + index])) return [];
  return next.slice(end + 1);
}

export function conversationInitials(title: string): string {
  const words = title.trim().split(/\s+/u);
  return (words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]).join("") : Array.from(words[0] ?? "").slice(0, 2).join("")).toLocaleUpperCase() || "群";
}

/**
 * 任务状态文案：归档任务不再报在跑/等你，否则在对话列表里和未归档任务读起来一样。
 * 列表任务行与批量断言共用这一份，不另写一套词表。
 */
export function conversationTaskStateLabel(entry: {
  task: { status: string };
  runs: ReadonlyArray<{ status: string }>;
  startup?: { state: string } | null;
}): string {
  if (entry.task.status === "archived") return "已归档";
  const run = entry.runs[0];
  if (!run) return entry.startup?.state === "failed" ? "启动失败" : "待开工";
  return ({
    running: "进行中", waiting_user: "等你回复", awaiting_approval: "等你批准",
    done: "完成", failed: "失败", stopped: "已停止",
  } as Record<string, string>)[run.status] ?? "";
}
