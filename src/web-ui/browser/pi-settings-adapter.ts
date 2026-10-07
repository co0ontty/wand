import { state } from "./state";
import { isPiSettingsDraft, type PiSessionSettings } from "../../pi-session-settings.js";
import { piSettingsController } from "../react/pi-settings/controller";
import { notifyLegacyUiChange } from "./ui-store-bridge";

function supportsPiSettings(session: any): boolean {
  return session?.sessionKind === "structured" && session.provider === "pi";
}

export function syncPiSettingsComposer(): void {
  const session = state.sessions.find((item) => item.id === state.selectedId);
  const target = document.querySelector<HTMLElement>("[data-pi-settings-host]");
  const toggleTarget = document.querySelector<HTMLElement>("[data-pi-settings-toggle-host]");
  const input = document.getElementById("input-box") as HTMLTextAreaElement | null;
  if (!target || !toggleTarget || !input || !supportsPiSettings(session) || state.terminalInteractive) {
    piSettingsController.clear(); return;
  }
  const draft = input.value;
  // 面板由两条路打开：草稿里的 `/settings` 这类命令，或输入框里的设置图标（与草稿无关）。
  const open = piSettingsController.isExpanded(session.id)
    || isPiSettingsDraft(draft) && !state.composerComposing && !piSettingsController.isDismissed(session.id, draft);
  piSettingsController.sync([{ key: "pi-settings", target, toggleTarget, sessionId: session.id, draft, open,
    onSaved: (id: string, settings: PiSessionSettings) => {
      const current = state.sessions.find((item) => item.id === id);
      if (!current) return;
      current.piSettings = settings;
      notifyLegacyUiChange("pi-settings");
    },
    returnFocus: () => {
      if (state.selectedId !== session.id) return;
      if (piSettingsController.openedBy() === "toggle") {
        toggleTarget.querySelector<HTMLElement>("button")?.focus();
        return;
      }
      input.focus();
    },
  }]);
}

/** Settings are navigation, not user prompts: no model call, queueing, or draft/attachment capture. */
export function handlePiSettingsSubmit(text: string, session: any): boolean {
  if (!supportsPiSettings(session) || state.terminalInteractive) return false;
  if (!isPiSettingsDraft(text)) { piSettingsController.dismiss(); return false; }
  syncPiSettingsComposer(); piSettingsController.reopen();
  piSettingsController.focusControl();
  return true;
}

export function handlePiSettingsKeydown(event: KeyboardEvent): boolean {
  const mount = piSettingsController.getSnapshot().mounts[0];
  if (!mount || !mount.open || event.isComposing || event.keyCode === 229) return false;
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); piSettingsController.dismiss(); mount.returnFocus(); return true;
  }
  // A visible settings panel must not steal Return/arrow keys from an ordinary message draft.
  if (piSettingsController.openedBy() === "toggle" && !isPiSettingsDraft(mount.draft)) return false;
  if ((event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation(); piSettingsController.focusControl(event.key === "ArrowUp"); return true;
  }
  return false;
}
