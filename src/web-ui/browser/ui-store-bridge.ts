import { readStoredBoolean, state } from "./state";
import {
  LegacyUiAdapter,
  applyLegacyUiAction,
  deriveLegacyUiSnapshot,
  type LegacySnapshotEnvironment,
  type LegacyUiCommands,
  type UiStore,
} from "../react/shell";

const AUTOMATION_EXPANDED_KEY = "wand-automation-sessions-expanded";
const HISTORY_EXPANDED_KEY = "wand-non-wand-sessions-expanded";

type LegacyChangeListener = (reason?: string) => void;

const legacyChangeListeners = new Set<LegacyChangeListener>();

/** Notify React after an imperative mutation that did not originate in UiStore. */
export function notifyLegacyUiChange(reason?: string): void {
  for (const listener of [...legacyChangeListeners]) listener(reason);
}

function browserEnvironment(): LegacySnapshotEnvironment {
  const nativeBridge = typeof WandNative === "undefined" ? undefined : WandNative;
  return {
    width: window.innerWidth,
    online: navigator.onLine,
    embedTerminal: document.documentElement.classList.contains("is-wand-embed-terminal"),
    nativeInput: Boolean(window.__wandImeNative || window.__wandIosNative),
    backToNative: typeof nativeBridge?.backToNative === "function",
    switchServer: typeof nativeBridge?.switchServer === "function",
    automationExpanded: readStoredBoolean(AUTOMATION_EXPANDED_KEY, false),
    historyExpanded: readStoredBoolean(HISTORY_EXPANDED_KEY, false),
  };
}

function subscribeBrowserChanges(listener: LegacyChangeListener): () => void {
  legacyChangeListeners.add(listener);
  const onResize = () => listener("viewport:resize");
  const onOnline = () => listener("network:online");
  const onOffline = () => listener("network:offline");
  window.addEventListener("resize", onResize);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    legacyChangeListeners.delete(listener);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

export interface BrowserUiStoreBridgeOptions {
  /** 0 uses microtask batching; values up to 200ms are supported. */
  batchMs?: number;
  freezeSnapshots?: boolean;
}

/**
 * Production bridge for the incremental migration. The command port is
 * injected by browser composition code so legacy circular imports do not leak
 * into the React shell boundary.
 */
export function createBrowserUiStoreBridge(
  commands: LegacyUiCommands,
  options: BrowserUiStoreBridgeOptions = {},
): UiStore {
  return new LegacyUiAdapter({
    readSnapshot: () => deriveLegacyUiSnapshot(state, browserEnvironment()),
    applyAction: (action) => applyLegacyUiAction(commands, action),
    subscribeLegacy: subscribeBrowserChanges,
    batchMs: options.batchMs,
    freezeSnapshots: options.freezeSnapshots,
  });
}

export type { LegacyUiCommands };
