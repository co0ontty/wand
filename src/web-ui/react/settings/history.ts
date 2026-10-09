import { settingsController, settingsStore } from "./controller";
import type { SettingsTab } from "./types";

const TABS: readonly SettingsTab[] = ["profile", "notifications", "display", "ai", "local-models", "speech", "general", "connectors", "security", "presets", "about"];

export function settingsRoute(search: string): SettingsTab | "directory" | null {
  const value = new URLSearchParams(search).get("settings");
  return value === "directory" ? value : TABS.includes(value as SettingsTab) ? value as SettingsTab : null;
}

export function settingsSearch(search: string, value: SettingsTab | "directory" | null): string {
  const params = new URLSearchParams(search);
  if (value) params.set("settings", value);
  else params.delete("settings");
  return params.size ? `?${params.toString()}` : "";
}

/** Settings coexist with the underlying workspace route; Back restores that exact view. */
export function installSettingsHistory(): () => void {
  let syncing = false;
  let previous = settingsStore.getSnapshot();
  const restore = (): void => {
    syncing = true;
    const route = settingsRoute(window.location.search);
    if (route) settingsController.open(route === "directory" ? undefined : route);
    else settingsController.close();
    previous = settingsStore.getSnapshot();
    syncing = false;
  };
  restore();
  const unsubscribe = settingsStore.subscribe(() => {
    const next = settingsStore.getSnapshot();
    if (syncing) return;
    if (next.open !== previous.open || next.tab !== previous.tab || next.detail !== previous.detail) {
      const url = new URL(window.location.href);
      url.search = settingsSearch(url.search, next.open ? next.detail ? next.tab : "directory" : null);
      const method = next.open && !previous.open ? "pushState" : "replaceState";
      window.history[method](window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    previous = next;
  });
  window.addEventListener("popstate", restore);
  return () => { unsubscribe(); window.removeEventListener("popstate", restore); };
}
