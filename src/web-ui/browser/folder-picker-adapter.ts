import {
  configureFolderPickerRuntime,
  folderPickerController,
  newSessionController,
  quickCommitController,
  settingsController,
  worktreeMergeController,
  type FolderPickerRuntimeAdapter,
} from "../react";
import { getEffectiveCwd } from "./render";
import { state } from "./state";
import { saveWorkingDir } from "./terminal";
import { showToast } from "./notifications";
import { setTailMarqueePathText } from "./utils";
import { isBrowserReactShellMounted } from "./shell-runtime";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";

let uninstallRuntime: (() => void) | null = null;

function setTriggerExpanded(expanded: boolean): void {
  if (isBrowserReactShellMounted()) return;
  document.getElementById("blank-chat-cwd")?.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function syncWorkingDirectoryUi(path: string): void {
  if (isBrowserReactShellMounted()) {
    notifyLegacyUiChange("working-dir");
    return;
  }
  const trigger = document.getElementById("blank-chat-cwd");
  if (trigger) trigger.title = `当前工作目录：${path}`;
  setTailMarqueePathText(document.getElementById("blank-chat-cwd-path"), path);

  const filePathInput = document.getElementById("file-explorer-cwd") as HTMLInputElement | null;
  if (!state.selectedId && filePathInput && document.activeElement !== filePathInput) {
    filePathInput.value = path;
    filePathInput.title = path;
  }
}

const legacyRuntime: FolderPickerRuntimeAdapter = {
  getInitialPath: getEffectiveCwd,

  onOpen(): void {
    newSessionController.closeIfOpen();
    quickCommitController.closeIfOpen();
    settingsController.closeIfOpen();
    worktreeMergeController.closeIfOpen();
    setTriggerExpanded(true);
  },

  onClose(): void {
    setTriggerExpanded(false);
    window.requestAnimationFrame(() => {
      document.getElementById("blank-chat-cwd")?.focus();
    });
  },

  applySelection(path): void {
    saveWorkingDir(path);
    syncWorkingDirectoryUi(path);
  },
};

function openFolderPickerNow(): boolean {
  for (const controller of [
    newSessionController,
    quickCommitController,
    settingsController,
    worktreeMergeController,
  ]) {
    if (controller.isOpen() && !controller.closeIfOpen()) return false;
  }
  // The controller runtime is the readiness contract. `reactUi=0` disables
  // only the generic overlay bridge; business Hosts remain mounted in the
  // fallback overlay root and must stay available through their adapters.
  if (!folderPickerController.open(getEffectiveCwd())) {
    showToast("工作目录选择器尚未就绪，请刷新页面后重试。", "error");
    return false;
  }
  return true;
}

export function openFolderPickerFromLegacy(): boolean {
  if (!prepareFilePreviewForCompetingOverlay(() => { openFolderPickerNow(); })) return false;
  return openFolderPickerNow();
}

function openFolderPicker(event: Event): void {
  event.preventDefault();
  openFolderPickerFromLegacy();
}

function findTrigger(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("#blank-chat-cwd") : null;
}

function handleClick(event: MouseEvent): void {
  if (isBrowserReactShellMounted()) return;
  if (!findTrigger(event.target)) return;
  openFolderPicker(event);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (isBrowserReactShellMounted()) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  if (!findTrigger(event.target)) return;
  openFolderPicker(event);
}

/** Installs the only adapter allowed to mutate the legacy working-directory runtime. */
export function installFolderPickerLegacyAdapter(): void {
  if (uninstallRuntime) return;
  uninstallRuntime = configureFolderPickerRuntime(legacyRuntime);
  document.addEventListener("click", handleClick);
  document.addEventListener("keydown", handleKeyDown);
}
