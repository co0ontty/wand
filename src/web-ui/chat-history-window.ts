/** Small transport pages; the browser fills them to a measured viewport buffer. */
export const CHAT_INITIAL_MESSAGE_COUNT = 8;
export const CHAT_HISTORY_BLOCK_BUDGET = 12;
export const CHAT_HISTORY_BYTE_BUDGET = 96 * 1024;
export const CHAT_HISTORY_BUFFER_SCREENS = 2;

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

export function chatHistoryRootMargin(height: number): string {
  return `${Math.max(0, Math.ceil(height * CHAT_HISTORY_BUFFER_SCREENS))}px 0px 0px 0px`;
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
