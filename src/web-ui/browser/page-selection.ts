/** Dependency-free seam: selection stays owned by session-engine, routing observes it. */
let listener: (() => void) | null = null;
export function configurePageSelection(next: () => void): void { listener = next; }
let pauseDepth = 0;
export function withoutPageSelection<T>(action: () => T): T { pauseDepth++; try { return action(); } finally { pauseDepth--; } }
export function notifyPageSelection(): void { if (!pauseDepth) listener?.(); }
let restore: (() => Promise<boolean>) | null = null;
export function configurePageRestore(next: () => Promise<boolean>): void { restore = next; }
export function restorePageNavigation(): Promise<boolean> { return restore?.() ?? Promise.resolve(false); }
