import { configureMissionsRuntime } from "../react/missions/controller";
import { persistSelectedId } from "./chat-scroll";
import { getEffectiveCwd, resetChatRenderCache } from "./render";
import { closeReactOverlays } from "./react-overlay-coordinator";
import { dismissDrawerIfOverlay, loadSessions, selectSession } from "./session-engine";
import { state } from "./state";

let uninstall: (() => void) | null = null;

export function installMissionsLegacyAdapter(): void {
  if (uninstall) return;
  uninstall = configureMissionsRuntime({
    onOpen() {
      closeReactOverlays(["missions"]);
      dismissDrawerIfOverlay();
    },
    onClose() {},
    effectiveCwd: getEffectiveCwd,
    async openSession(sessionId) {
      await loadSessions();
      if (!state.sessions.some((session: { id: string }) => session.id === sessionId)) return;
      state.selectedId = sessionId;
      persistSelectedId();
      resetChatRenderCache();
      selectSession(sessionId);
      dismissDrawerIfOverlay();
    },
  });
}
