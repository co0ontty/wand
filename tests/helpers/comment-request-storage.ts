export async function withCommentRequestStorage<T>(run: (records: Map<string, string>) => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const records = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
    removeItem: (key: string) => records.delete(key),
  } });
  try { return await run(records); }
  finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
}
