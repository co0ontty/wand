import {
  configureFolderPickerRuntime,
  folderPickerController,
  type FolderPickerRuntimeAdapter,
} from "../react";
import { getEffectiveCwd } from "./render";
import { saveWorkingDir } from "./terminal";
import { showToast } from "./notifications";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";
import { closeReactOverlays } from "./react-overlay-coordinator";

let uninstallRuntime: (() => void) | null = null;

// #blank-chat-cwd* 只在已删除的 legacy 空白页 markup 里存在，React 的空白页不渲染
// 它们（登录页 / 桌面 / 移动端 / 原生 embed 四种状态探针均 0 命中），所以这里只保留
// 目录变更通知。
function syncWorkingDirectoryUi(_path: string): void {
  notifyLegacyUiChange("working-dir");
}

const legacyRuntime: FolderPickerRuntimeAdapter = {
  getInitialPath: getEffectiveCwd,

  onOpen(): void {
    closeReactOverlays(["folderPicker"]);
  },

  onClose(): void {
    // React 的空白页没有 legacy 的 #blank-chat-cwd 触发器可聚焦。
  },

  applySelection(path): void {
    saveWorkingDir(path);
    syncWorkingDirectoryUi(path);
  },
};

function openFolderPickerNow(): boolean {
  if (!closeReactOverlays(["folderPicker"])) return false;
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

// legacy 空白页的 #blank-chat-cwd 触发器已随 legacy Shell 一起删除，React 通过
// shell-commands 的 openFolderPicker 命令直接调 openFolderPickerFromLegacy()，
// 所以 document 级 click/keydown 代理已无作用对象。

/** Installs the only adapter allowed to mutate the legacy working-directory runtime. */
export function installFolderPickerLegacyAdapter(): void {
  if (uninstallRuntime) return;
  uninstallRuntime = configureFolderPickerRuntime(legacyRuntime);
}
