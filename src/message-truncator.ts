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

/**
 * 块级窗口的默认预算：init/REST 默认只下发最近这么多个「内容块」（跨 turn 累计，
 * 必要时切掉最旧那条 turn 的头部），更早的块由客户端滚动到顶时按需分页拉取。
 * turn 级窗口（MESSAGE_WINDOW_SIZE）对「单条 turn 携带上百块」的长任务无能为力——
 * 一条流式 assistant turn 可膨胀到 1MB+，整条下发会撑爆移动端 WS 帧、拖慢打开。
 * 块级窗口是对这种会话的根治手段。仅在客户端显式带 blockBudget 时启用（iOS），
 * Web/Android 走原有 turn 级路径不受影响。
 */
export const MESSAGE_BLOCK_WINDOW = 60;

export interface WindowedMessages {
  /** 已截断 + 窗口化后的 turn 列表（最近 windowSize 条）。 */
  messages: ConversationTurn[];
  /** messages[0] 在完整历史里的绝对下标（0 表示已含最早一条）。 */
  messageOffset: number;
  /** 完整历史的 turn 总数（客户端据此判断是否还有更早的可加载）。 */
  messageTotal: number;
}

export interface BlockWindowedMessages extends WindowedMessages {
  /** messages[0] 被切掉的头部块数（0 表示该 turn 完整；>0 表示其更早的块需翻页）。 */
  leadingBlockOffset: number;
  /** turn messageOffset 的完整块数（客户端据此判断该 turn 是否已全部加载）。 */
  leadingBlockTotal: number;
}

/**
 * 块级窗口：取完整历史「最近 blockBudget 个内容块」并做 transport 截断。
 * 从最新 turn 往回累计块数，能整条放下就整条放，放不下的那条（最旧的入窗 turn）
 * 只取其尾部若干块，并通过 leadingBlockOffset 告知客户端「这条 turn 还有更早的块」。
 * 客户端先按块翻完这条 turn 的头部，再按 turn 往前翻更早的整条。
 */
export function blockWindowMessagesForTransport(
  all: ConversationTurn[] | undefined,
  cardDefaults: CardExpandDefaults,
  blockBudget: number = MESSAGE_BLOCK_WINDOW,
): BlockWindowedMessages {
  const turns = all ?? [];
  const total = turns.length;
  if (total === 0) {
    return { messages: [], messageOffset: 0, messageTotal: 0, leadingBlockOffset: 0, leadingBlockTotal: 0 };
  }
  const budget = Math.max(1, blockBudget);

  let startTurn = total - 1;
  let leadingBlockOffset = 0;
  let acc = 0;
  for (let i = total - 1; i >= 0; i--) {
    const n = turns[i].content.length;
    if (i === total - 1) {
      // 最新一条 turn 必须入窗：整条放得下就整条，放不下取尾部 budget 块。
      if (n <= budget) {
        acc = n;
        startTurn = i;
        leadingBlockOffset = 0;
      } else {
        startTurn = i;
        leadingBlockOffset = n - budget;
        acc = budget;
        break;
      }
    } else if (acc + n <= budget) {
      acc += n;
      startTurn = i;
      leadingBlockOffset = 0;
    } else {
      const remaining = budget - acc;
      if (remaining > 0) {
        startTurn = i;
        leadingBlockOffset = n - remaining;
        acc += remaining;
      }
      break;
    }
  }

  const windowedTurns: ConversationTurn[] = [];
  for (let i = startTurn; i < total; i++) {
    if (i === startTurn && leadingBlockOffset > 0) {
      windowedTurns.push({ ...turns[i], content: turns[i].content.slice(leadingBlockOffset) });
    } else {
      windowedTurns.push(turns[i]);
    }
  }

  return {
    messages: truncateMessagesForTransport(windowedTurns, cardDefaults),
    messageOffset: startTurn,
    messageTotal: total,
    leadingBlockOffset,
    leadingBlockTotal: turns[startTurn].content.length,
  };
}

/**
 * 块级翻页：取某条 turn 的 content[start, end) 这一段（已做 transport 截断）。
 * 客户端滚动到顶、且当前最旧 turn 仍有更早块时调用，end = 客户端当前 leadingBlockOffset。
 */
export function sliceTurnBlocksForTransport(
  turn: ConversationTurn,
  start: number,
  end: number,
  cardDefaults: CardExpandDefaults,
): ContentBlock[] {
  const blocks = turn.content.slice(start, end);
  if (blocks.length === 0) return [];
  return truncateMessagesForTransport([{ ...turn, content: blocks }], cardDefaults)[0].content;
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
