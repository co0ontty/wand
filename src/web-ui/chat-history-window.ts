/** Small transport pages; the browser fills them to a measured viewport buffer. */
export const CHAT_INITIAL_MESSAGE_COUNT = 8;
export { CONVERSATION_INITIAL_TURNS, CONVERSATION_HISTORY_PAGE_TURNS, CHAT_HISTORY_BUFFER_SCREENS, chatHistoryRootMargin } from "./react/conversations/presentation.js";
import { CHAT_HISTORY_BUFFER_SCREENS } from "./react/conversations/presentation.js";
export const CHAT_HISTORY_BLOCK_BUDGET = 12;
export const CHAT_HISTORY_BYTE_BUDGET = 96 * 1024;

export interface ChatScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/** The chat scroller is column-reverse (latest at scrollTop=0). */
export function chatHistoryBufferRemaining(geometry: ChatScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight - Math.abs(geometry.scrollTop));
}

export function needsChatHistoryBuffer(geometry: ChatScrollGeometry): boolean {
  return geometry.clientHeight > 0
    && chatHistoryBufferRemaining(geometry) < geometry.clientHeight * CHAT_HISTORY_BUFFER_SCREENS;
}

/** One attempt per cursor until progress or an explicit retry. Height decides
 * how much to prefetch, never whether a successful page made progress:
 * scrollHeight stays at clientHeight while the screen is underfilled, and
 * folded tool pages may add no visible height at all. */
export class ChatHistoryPrefetchGate {
  private attempt = "";
  canAttempt(scope: string, cursor: string, manual = false): boolean {
    return manual || this.attempt !== `${scope}\0${cursor}`;
  }
  attempted(scope: string, cursor: string): void {
    this.attempt = `${scope}\0${cursor}`;
  }
}
