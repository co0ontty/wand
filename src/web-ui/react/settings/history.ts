import { subscribePageRoute, updatePageRoute } from "../../page-route";
import { settingsController, settingsStore } from "./controller";
import type { SettingsTab } from "./types";

const TABS: readonly SettingsTab[] = ["profile", "notifications", "display", "ai", "local-models", "general", "connectors", "security", "presets", "about"];

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
    const current = settingsStore.getSnapshot();
    if (route) {
      if (!current.open || (route === "directory" ? current.detail : current.tab !== route || !current.detail)) settingsController.open(route === "directory" ? undefined : route);
      settingsStore.setNested(new URLSearchParams(window.location.search).get("settingsNested") === "environment" ? "environment" : null);
    } else settingsController.close();
    previous = settingsStore.getSnapshot();
    syncing = false;
  };
  restore();
  const unsubscribe = settingsStore.subscribe(() => {
    const next = settingsStore.getSnapshot();
    if (syncing) return;
    if (next.open !== previous.open || next.tab !== previous.tab || next.detail !== previous.detail || next.nested !== previous.nested) {
      updatePageRoute({ settings: next.open ? next.detail ? next.tab : "directory" : null, settingsNested: next.open ? next.nested : null });
    }
    previous = next;
  });
  const stopRoute = subscribePageRoute(restore);
  return () => { unsubscribe(); stopRoute(); };
}
