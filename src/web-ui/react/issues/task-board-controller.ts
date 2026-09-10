export interface TaskBoardControllerSnapshot { open: boolean; workspaceId: string; sessionId: string; revision: number; }
type Listener = () => void;
let snapshot: TaskBoardControllerSnapshot = { open: false, workspaceId: "", sessionId: "", revision: 0 };
const listeners = new Set<Listener>();
function publish(next: Partial<TaskBoardControllerSnapshot>): void { snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 }; listeners.forEach((listener) => listener()); }
export const taskBoardController = { open(workspaceId = "", sessionId = ""): void { publish({ open: true, workspaceId, sessionId }); }, close(): void { if (snapshot.open) publish({ open: false }); } };
export const taskBoardStore = { subscribe(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot(): TaskBoardControllerSnapshot { return snapshot; } };
declare global { interface Window { __wandReactTaskBoard?: typeof taskBoardController; } }
