import { state } from "./state";

interface NotificationPreferencesDetail {
  sound?: boolean;
  volume?: number;
  bubble?: boolean;
}

/** Keeps still-legacy notification/card consumers hot while Settings is React-owned. */
export function installSettingsRuntimeBridge(): void {
  window.addEventListener("wand-settings-notifications-changed", (event) => {
    const detail = (event as CustomEvent<NotificationPreferencesDetail>).detail || {};
    if (typeof detail.sound === "boolean") state.notifSound = detail.sound;
    if (typeof detail.volume === "number") state.notifVolume = detail.volume;
    if (typeof detail.bubble === "boolean") state.notifBubble = detail.bubble;
  });

  window.addEventListener("wand-settings-config-saved", (event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!detail) return;
    if (!state.config) state.config = {};
    Object.assign(state.config, detail);
  });
}
