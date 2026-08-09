import { folderPickerController } from "../react/folder-picker/controller";
import { newSessionController } from "../react/new-session/controller";
import { quickCommitController } from "../react/quick-commit/controller";
import { settingsController } from "../react/settings/controller";
import { worktreeMergeController } from "../react/worktree-merge/controller";
import { missionsController } from "../react/missions/controller";
import { workspacesController } from "../react/workspaces/controller";

export type ReactOverlayName = "folderPicker" | "missions" | "newSession" | "quickCommit" | "settings" | "worktreeMerge" | "workspaces";

interface ClosableOverlayController {
  isOpen(): boolean;
  closeIfOpen(): boolean;
}

const REACT_OVERLAY_CONTROLLERS: Record<ReactOverlayName, ClosableOverlayController> = {
  folderPicker: folderPickerController,
  missions: missionsController,
  newSession: newSessionController,
  quickCommit: quickCommitController,
  settings: settingsController,
  worktreeMerge: worktreeMergeController,
  workspaces: workspacesController,
};

function closeReactOverlay(controller: ClosableOverlayController | null | undefined): boolean {
  return !controller?.isOpen() || controller.closeIfOpen();
}

export function closeReactOverlays(except: readonly ReactOverlayName[] = []): boolean {
  const excluded = new Set(except);
  for (const [name, controller] of Object.entries(REACT_OVERLAY_CONTROLLERS) as Array<[ReactOverlayName, ClosableOverlayController]>) {
    if (excluded.has(name)) continue;
    if (!closeReactOverlay(controller)) return false;
  }
  return true;
}
