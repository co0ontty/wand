import { parseJsonResponse } from "./http-adapter";
import { createQuerySnapshot } from "../query-snapshot";

/** One committed `/api/config` read for boot, profile, home and new-session entry points. */
export type WandConfigSnapshot = Record<string, unknown>;

const snapshot = createQuerySnapshot<WandConfigSnapshot>(async () => {
  const response = await fetch("/api/config", { credentials: "same-origin" });
  return parseJsonResponse<WandConfigSnapshot>(response);
});

export function peekConfigSnapshot(): WandConfigSnapshot | null {
  return snapshot.peek();
}

export function loadConfigSnapshot(): Promise<WandConfigSnapshot> {
  return snapshot.load();
}

export function subscribeConfigSnapshot(listener: () => void): () => void {
  return snapshot.subscribe(listener);
}

/**
 * Settings saves carry a partial config. Merge it instead of replacing the
 * snapshot, and cut off any read that predates the save.
 */
export function mergeConfigSnapshot(patch: WandConfigSnapshot): void {
  const current = snapshot.peek();
  if (!current) {
    snapshot.invalidate();
    return;
  }
  snapshot.publish({ ...current, ...patch });
}

export function invalidateConfigSnapshot(): void {
  snapshot.invalidate();
}

if (typeof window !== "undefined") {
  window.addEventListener("wand-settings-config-saved", (event) => {
    const detail = (event as CustomEvent<WandConfigSnapshot>).detail;
    if (detail && typeof detail === "object") mergeConfigSnapshot(detail);
  });
}
