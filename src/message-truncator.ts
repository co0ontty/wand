/**
 * Truncates tool_result content in messages for WebSocket transport.
 * Cards that are collapsed by default have their large results replaced
 * with a summary, and clients fetch full content on-demand via API.
 */

import type { CardExpandDefaults, ContentBlock, ConversationTurn, ToolResultBlock, ToolUseBlock } from "./types.js";

const TRUNCATION_THRESHOLD = 200;
const SUMMARY_LENGTH = 100;

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
