/**
 * A one-use handoff from authenticated startup to the normal query owner.
 * No polling or durable cache: failures are evicted, mutations/logout detach the
 * handoff, and later ordinary reads always go back to the repository.
 */
export function createStartupPreload<T>(read: () => Promise<T>) {
  let preloaded: Promise<T> | null = null;
  return {
    preload(): void {
      if (preloaded) return;
      const request = read();
      preloaded = request;
      void request.catch(() => { if (preloaded === request) preloaded = null; });
    },
    load(): Promise<T> {
      const request = preloaded;
      preloaded = null;
      return request ?? read();
    },
    clear(): void { preloaded = null; },
  };
}
