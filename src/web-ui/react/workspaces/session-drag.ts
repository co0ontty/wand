export const SESSION_DRAG_TYPE = "application/x-wand-session";

export function isSessionDrag(data: Pick<DataTransfer, "types">): boolean {
  return Array.from(data.types).includes(SESSION_DRAG_TYPE);
}

export function startSessionDrag(data: DataTransfer, sessionId: string): void {
  data.effectAllowed = "move";
  data.setData(SESSION_DRAG_TYPE, sessionId);
}

export function draggedSessionId(data: Pick<DataTransfer, "getData">): string {
  return data.getData(SESSION_DRAG_TYPE).trim();
}
