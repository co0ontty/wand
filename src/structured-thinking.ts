import type { ContentBlock } from "./types.js";

function lastThinking(blocks: ContentBlock[]): Extract<ContentBlock, { type: "thinking" }> | undefined {
  const last = blocks.at(-1);
  return last?.type === "thinking" ? last : undefined;
}

/**
 * Reasoning events can carry boundaries only. Observation times are supplied
 * by the live runner; historical replay must not invent recent activity.
 *
 * 有些 provider 会为一轮没有产出任何正文的思考发边界事件。这种轮次不该变成
 * 一个空的思考块：它会在时间线里留下一条永远「思考中」又读不到内容的条目，
 * 也会把轮次计数撑大。边界自证没有正文时直接丢弃，只有正在写的那一轮保留占位。
 */
export function updateThinkingActivity(
  blocks: ContentBlock[], update: Record<string, unknown> | null | undefined, observedAt?: string,
): void {
  const type = update?.type;
  if (type !== "thinking_start" && type !== "thinking_delta" && type !== "thinking_end") return;
  const content = typeof update?.content === "string" ? update.content : "";
  let last = lastThinking(blocks);
  if (type === "thinking_end" && last && !last.thinking.trim() && !content.trim()) {
    blocks.pop();
    return;
  }
  // 上一轮只开了头就再开一轮：那个空块没有发生过，不是进行中的占位。
  if (type === "thinking_start" && last && !last.thinking.trim()) blocks.pop();
  last = lastThinking(blocks);
  if (!last) {
    last = { type: "thinking", thinking: "" };
    blocks.push(last);
  }
  if (observedAt) {
    last.occurredAt ??= observedAt;
    last.lastActivityAt = observedAt;
  }
}

/**
 * 一条 assistant 消息结束时用它收尾：正文里没有思考内容时，丢掉流式留下的空占位。
 * 返回是否清理过，供调用方在同一条消息没有正文时不再留下空轮次。
 */
export function settleThinkingRound(
  blocks: ContentBlock[], messageThinking: string,
): void {
  if (messageThinking.trim()) return;
  const last = lastThinking(blocks);
  if (last && !last.thinking.trim()) blocks.pop();
}