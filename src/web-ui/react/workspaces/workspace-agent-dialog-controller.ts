type Listener = () => void;

export interface WorkspaceAgentDialogSnapshot {
  open: boolean;
  revision: number;
}

const EMPTY: WorkspaceAgentDialogSnapshot = { open: false, revision: 0 };
let snapshot = EMPTY;
const listeners = new Set<Listener>();

function publish(open: boolean): void {
  if (snapshot.open === open) return;
  snapshot = { open, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
}

/** Shared entry point used by both the task welcome page and the tab-bar add button. */
export const workspaceAgentDialogController = {
  open(): void {
    publish(true);
  },
  close(): void {
    publish(false);
  },
};

export const workspaceAgentDialogStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): WorkspaceAgentDialogSnapshot {
    return snapshot;
  },
  getServerSnapshot(): WorkspaceAgentDialogSnapshot {
    return EMPTY;
  },
};
