import type { ConversationTurn } from "../../../types.js";

/**
 * 「还跟着最新一条」的距底阈值：外层群聊列表、live 卡片与 IM 会话恢复共用这一个数，
 * 免得三处阈值漂到不同值。
 */
export const CONVERSATION_TAIL_PX = 24;

/**
 * IM 历史按回合成页：首屏只挂最新一页，靠近顶部时再逐页向前补。
 * 浏览器聊天滚动共用同一组页尺寸与预取余量，AI 团队视图直接复用，避免两套窗口漂移。
 */
export const CONVERSATION_INITIAL_TURNS = 20;
export const CONVERSATION_HISTORY_PAGE_TURNS = 20;
export const CHAT_HISTORY_BUFFER_SCREENS = 2;

export function chatHistoryRootMargin(height: number): string {
  return `${Math.max(0, Math.ceil(height * CHAT_HISTORY_BUFFER_SCREENS))}px 0px 0px 0px`;
}

/**
 * 会话恢复位置的存档口径（`conversationUi.scrolls` 的取值）：
 * `-1` 是「离开时本来就贴底」；`-2` 及以下是从底部往上量的像素距离（反码），
 * 非负数是旧版绝对位置。历史按窗口渲染后绝对位置会随窗口起点漂移，
 * 距底距离才是与内容变化无关的稳定量；贴底单独存档，恢复时按当期内容高度重新贴底。
 */
export const CONVERSATION_SCROLL_FOLLOW_TAIL = -1;

interface ScrollBox { scrollTop: number; scrollHeight: number; clientHeight: number }

/** 读取存档：没记录或脏数据返回 undefined，调用方按「贴底」处理。 */
export function storedConversationScroll(saved: number | undefined): number | undefined {
  return typeof saved === "number" && Number.isFinite(saved) ? saved : undefined;
}

/** 写档：贴底存哨兵，否则存距底像素距离。 */
export function conversationScrollRecord(scroll: ScrollBox): number {
  const distance = scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight);
  return distance <= CONVERSATION_TAIL_PX ? CONVERSATION_SCROLL_FOLLOW_TAIL : -(Math.round(distance) + 2);
}

/**
 * 按存档恢复滚动位置。距底记录在当前窗口里够不着时 `needsEarlier` 为真，
 * 调用方先向历史方向扩一页再恢复，不能把目标裁成 0 假装恢复成功。
 */
export function conversationScrollRestore(saved: number | undefined, scroll: ScrollBox): { top: number; needsEarlier: boolean } {
  const record = storedConversationScroll(saved);
  if (record === undefined || record === CONVERSATION_SCROLL_FOLLOW_TAIL) return { top: scroll.scrollHeight, needsEarlier: false };
  if (record >= 0) return { top: record, needsEarlier: false };
  const top = scroll.scrollHeight - scroll.clientHeight - (-record - 2);
  return { top: Math.max(0, top), needsEarlier: top < 0 };
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
