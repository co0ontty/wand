/**
 * Truncates tool_result content in messages for WebSocket transport.
 * Cards that are collapsed by default have their large results replaced
 * with a summary, and clients fetch full content on-demand via API.
 */
import type { CardExpandDefaults, ConversationTurn } from "./types.js";
/**
 * Truncate messages for WebSocket transport. Tool results for collapsed card
 * types are replaced with a short summary when they exceed the threshold.
 *
 * @param messages - Original messages array (not mutated)
 * @param cardDefaults - Current card expand defaults from config
 * @param streamingTurnIndex - Index of the currently streaming turn (-1 if none).
 *   Tool results in the streaming turn are never truncated.
 */
export declare function truncateMessagesForTransport(messages: ConversationTurn[], cardDefaults: CardExpandDefaults, streamingTurnIndex?: number): ConversationTurn[];
