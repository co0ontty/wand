export interface IssuesControllerSnapshot { open: boolean; sessionId: string; revision: number; }
type Listener = () => void;
let snapshot: IssuesControllerSnapshot = { open: false, sessionId: "", revision: 0 };
const listeners = new Set<Listener>();
function publish(next: Partial<IssuesControllerSnapshot>): void { snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 }; listeners.forEach((listener) => listener()); }
export const githubIssuesController = { open(sessionId = ""): boolean { publish({ open: true, sessionId }); return true; }, close(): void { if (snapshot.open) publish({ open: false }); } };
export const githubIssuesStore = { subscribe(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot(): IssuesControllerSnapshot { return snapshot; } };
declare global { interface Window { __wandReactGithubIssues?: typeof githubIssuesController; } }
