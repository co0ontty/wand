export const REACT_UI_STORAGE_KEY = "wand.reactUi.enabled";

declare global {
  interface Window {
    __wandFeatureFlags?: {
      reactUi?: boolean;
    };
  }
}

function readBoolean(value: string | null | undefined): boolean | null {
  if (value == null || value === "") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "off", "disabled"].includes(normalized)) return false;
  return null;
}

/**
 * Runtime rollback switch for the generic React dialog/toast layer.
 *
 * Precedence: `?reactUi=0|1`, `window.__wandFeatureFlags.reactUi`, then
 * `localStorage["wand.reactUi.enabled"]`. The default is enabled. None of the
 * overrides are persisted implicitly, so a support link can disable React for
 * one page load without changing the user's browser state.
 *
 * This switch does NOT affect the authenticated Shell: the legacy Shell has
 * been removed, so the React Shell always mounts. Migrated business overlays
 * also stay hosted because they no longer have legacy DOM twins; callers of
 * those public entry points must never succeed without a mounted surface.
 */
export function isReactUiEnabled(target: Window = window): boolean {
  try {
    const queryValue = readBoolean(new URL(target.location.href).searchParams.get("reactUi"));
    if (queryValue != null) return queryValue;
  } catch {
    // A restricted WebView can reject location access. Continue to the next source.
  }

  const configured = target.__wandFeatureFlags?.reactUi;
  if (typeof configured === "boolean") return configured;

  try {
    const stored = readBoolean(target.localStorage.getItem(REACT_UI_STORAGE_KEY));
    if (stored != null) return stored;
  } catch {
    // Private browsing and embedded WebViews may make localStorage unavailable.
  }

  return true;
}
