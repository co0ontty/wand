/**
 * Insertion-ordered key set with a size bound. Keys are never refreshed on
 * lookup, so insertion order is age order and eviction needs no sorting.
 * When the set grows past maxSize, the oldest half (rounded up) is dropped in
 * one pass, which keeps insertion O(1) amortized.
 */
export class BoundedKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly maxSize: number) {
    if (!Number.isInteger(maxSize) || maxSize < 1) throw new Error("BoundedKeySet maxSize must be a positive integer");
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    if (this.keys.size > this.maxSize) this.evictOldestHalf();
  }

  delete(key: string): boolean {
    return this.keys.delete(key);
  }

  /** Removes every key the predicate matches; used to forget one session's keys. */
  deleteMatching(predicate: (key: string) => boolean): void {
    for (const key of Array.from(this.keys)) {
      if (predicate(key)) this.keys.delete(key);
    }
  }

  clear(): void {
    this.keys.clear();
  }

  private evictOldestHalf(): void {
    const drop = Math.ceil(this.keys.size / 2);
    const oldest = Array.from(this.keys).slice(0, drop);
    for (const key of oldest) this.keys.delete(key);
  }
}
