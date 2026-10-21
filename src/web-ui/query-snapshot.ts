/**
 * Shared single-flight read snapshot.
 *
 * Every consumer of one query dimension shares the committed value and the
 * in-flight request. A generation counter makes push/local-save publishes
 * authoritative: a read that started before the publish can never commit its
 * older payload. Invalidation detaches in-flight reads so the next load owns a
 * fresh request; detached reads still settle for their callers but never write.
 */
export interface QuerySnapshotLoadOptions {
  /** Ignore the committed value, but still join an already-running request. */
  force?: boolean;
  /**
   * Serve the committed value only while the last real read is younger than
   * this budget. Local publishes do not reset the clock: they keep the value
   * fresh for the UI without pretending the server was re-read.
   */
  maxAgeMs?: number;
}

export interface QuerySnapshot<T> {
  peek(): T | null;
  load(options?: QuerySnapshotLoadOptions): Promise<T>;
  publish(value: T): void;
  /** Keep the committed value for the UI, but require the next read to hit the server again. */
  stale(): void;
  invalidate(): void;
  subscribe(listener: () => void): () => void;
}

export interface QuerySnapshotOptions<T> {
  /** Suppress subscriber notifications when a commit matches the current value. */
  equals?(previous: T, next: T): boolean;
}

export function createQuerySnapshot<T>(
  fetcher: () => Promise<T>,
  options: QuerySnapshotOptions<T> = {},
): QuerySnapshot<T> {
  let value: T | null = null;
  let pending: Promise<T> | null = null;
  let generation = 0;
  let lastReadAt = 0;
  let needsRead = false;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const commit = (next: T): void => {
    const changed = value === null || !options.equals?.(value, next);
    value = next;
    if (changed) notify();
  };

  const load = (loadOptions?: QuerySnapshotLoadOptions): Promise<T> => {
    if (!loadOptions?.force && value !== null && !needsRead) {
      const maxAge = loadOptions?.maxAgeMs;
      if (maxAge === undefined || Date.now() - lastReadAt <= maxAge) return Promise.resolve(value);
    }
    if (pending) return pending;
    const started = generation;
    let source: Promise<T>;
    try {
      source = fetcher();
    } catch (error) {
      source = Promise.reject(error);
    }
    let request: Promise<T>;
    request = source.then((result) => {
      if (pending === request) pending = null;
      // A publish or invalidation happened while this read was in flight.
      if (started !== generation) return value ?? result;
      lastReadAt = Date.now();
      needsRead = false;
      commit(result);
      return result;
    }, (error) => {
      if (pending === request) pending = null;
      throw error;
    });
    pending = request;
    return request;
  };

  return {
    peek: () => value,
    load,
    publish(next: T): void {
      generation++;
      pending = null;
      commit(next);
    },
    invalidate(): void {
      generation++;
      pending = null;
      value = null;
      lastReadAt = 0;
      needsRead = false;
    },
    stale(): void {
      // The value stays visible, but the next reader must go back to the server.
      needsRead = true;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
