export const TASK_DRAG_TYPE = "application/x-wand-task";

/** Cards also carry text/plain for third-party drops; only this MIME identifies our own drags. */
export function isTaskDrag(data: Pick<DataTransfer, "types">): boolean {
  return Array.from(data.types).includes(TASK_DRAG_TYPE);
}

export function startTaskDrag(data: DataTransfer, taskId: string): void {
  data.effectAllowed = "move";
  data.setData("text/plain", taskId);
  data.setData(TASK_DRAG_TYPE, taskId);
}

/** Column drop targets also accept legacy text/plain sources; the archive zone does not. */
export function draggedTaskId(data: Pick<DataTransfer, "getData">): string {
  return data.getData(TASK_DRAG_TYPE).trim() || data.getData("text/plain").trim();
}
