type Listener = () => void;
const listeners = new Set<Listener>();

/** Both task views invalidate after a successful mutation, never optimistically. */
export function notifyTasksChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeTaskChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function taskMutationCompleted<T>(result: T): T {
  notifyTasksChanged();
  return result;
}
