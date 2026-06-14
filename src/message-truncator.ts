/**
 * Truncates tool_result content in messages for WebSocket transport.
 * Cards that are collapsed by default have their large results replaced
 * with a summary, and clients fetch full content on-demand via API.
 */

import type { CardExpandDefaults, ContentBlock, ConversationTurn, ToolResultBlock, ToolUseBlock } from "./types.js";

const TRUNCATION_THRESHOLD = 200;
const SUMMARY_LENGTH = 100;

/**
 * 默认窗口大小：init/resync/快照/REST 默认只下发最近这么多条 turn，更早的由客户端
 * 滚动到顶时按需分页拉取。移动端 WebSocket 单帧上限（iOS 默认 1 MiB）下，长会话一次
 * 全量下发会撑爆帧导致反复断连——窗口化是根治手段，64MB 提帧只是兜底。
 */
export const MESSAGE_WINDOW_SIZE = 40;

export interface WindowedMessages {
  /** 已截断 + 窗口化后的 turn 列表（最近 windowSize 条）。 */
  messages: ConversationTurn[];
  /** messages[0] 在完整历史里的绝对下标（0 表示已含最早一条）。 */
  messageOffset: number;
  /** 完整历史的 turn 总数（客户端据此判断是否还有更早的可加载）。 */
  messageTotal: number;
}

/**
 * 取完整历史的「最近 windowSize 条」并对其做 transport 截断，附带 offset/total 元数据。
 * 客户端持有的永远是一段连续的「后缀」（最近的若干条），更早的按 offset 往前翻页。
 */
export function windowMessagesForTransport(
  all: ConversationTurn[] | undefined,
  cardDefaults: CardExpandDefaults,
  windowSize: number = MESSAGE_WINDOW_SIZE,
): WindowedMessages {
  const total = all?.length ?? 0;
  const offset = Math.max(0, total - windowSize);
  const slice = all ? all.slice(offset) : [];
  return {
    messages: truncateMessagesForTransport(slice, cardDefaults),
    messageOffset: offset,
    messageTotal: total,
  };
}

/** Tool name → cardDefaults field mapping */
function isToolDefaultCollapsed(toolName: string, defaults: CardExpandDefaults): boolean {
  switch (toolName) {
    case "Read": case "Glob": case "Grep": case "WebFetch": case "WebSearch": case "TodoRead":
      return defaults.inlineTools !== true;
    case "Bash":
      return defaults.terminal !== true;
    case "Edit": case "Write": case "MultiEdit":
      return defaults.editCards !== true;
    default:
      return false;
  }
}

function getContentString(content: ToolResultBlock["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Truncate messages for WebSocket transport. Tool results for collapsed card
 * types are replaced with a short summary when they exceed the threshold.
 *
 * @param messages - Original messages array (not mutated)
 * @param cardDefaults - Current card expand defaults from config
 * @param streamingTurnIndex - Index of the currently streaming turn (-1 if none).
 *   Tool results in the streaming turn are never truncated.
 */
export function truncateMessagesForTransport(
  messages: ConversationTurn[],
  cardDefaults: CardExpandDefaults,
  streamingTurnIndex = -1,
): ConversationTurn[] {
  return messages.map((turn, turnIndex) => {
    // Never truncate the currently streaming turn
    if (turnIndex === streamingTurnIndex) return turn;

    const toolNameMap = new Map<string, string>();
    for (const block of turn.content) {
      if (block.type === "tool_use") {
        toolNameMap.set((block as ToolUseBlock).id, (block as ToolUseBlock).name);
      }
    }

    let changed = false;
    const truncatedContent: ContentBlock[] = turn.content.map((block) => {
      if (block.type !== "tool_result") return block;

      const result = block as ToolResultBlock;

      // Never truncate errors
      if (result.is_error) return block;

      const toolName = toolNameMap.get(result.tool_use_id) || "";
      if (!isToolDefaultCollapsed(toolName, cardDefaults)) return block;

      const contentStr = getContentString(result.content);
      if (contentStr.length <= TRUNCATION_THRESHOLD) return block;

      changed = true;
      return {
        ...result,
        content: contentStr.slice(0, SUMMARY_LENGTH) + "…",
        _truncated: true,
      } as ToolResultBlock;
    });

    return changed ? { ...turn, content: truncatedContent } : turn;
  });
}
