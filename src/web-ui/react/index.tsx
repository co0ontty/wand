import { createRoot, type Root } from "react-dom/client";
import { isReactUiEnabled } from "./feature-flags";
import { OverlayHost } from "./overlay-host";
import { installReactUiStyles } from "./styles";
import { wandOverlay, type WandOverlay } from "./overlay-controller";
import { settingsController } from "./settings/controller";
import { newSessionController } from "./new-session/controller";
import { folderPickerController } from "./folder-picker/controller";
import { quickCommitController } from "./quick-commit/controller";
import { worktreeMergeController } from "./worktree-merge/controller";
import { restartOverlayController } from "./restart-overlay/controller";
import { filePreviewController } from "./file-preview/controller";
import { missionsController } from "./missions/controller";
import { workspacesController } from "./workspaces/controller";

const OVERLAY_ROOT_ID = "overlay-root";
const REACT_MOUNT_ID = "wand-react-ui-mount";
const PORTAL_CONTAINER_ID = "wand-react-ui-portals";

let activeRoot: Root | null = null;

declare global {
  interface Window {
    __wandReactUi?: WandOverlay;
  }
}

function getOrCreateChild(parent: HTMLElement, id: string, className: string): HTMLElement {
  const existing = document.getElementById(id);
  if (existing && existing.parentElement === parent) return existing;
  const element = document.createElement("div");
  element.id = id;
  element.className = className;
  parent.appendChild(element);
  return element;
}

function getOrCreateOverlayRoot(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) return existing;
  const root = document.createElement("div");
  root.id = OVERLAY_ROOT_ID;
  root.dataset.wandUiRoot = "";
  document.body.appendChild(root);
  return root;
}

function exposeBusinessControllers(): void {
  window.__wandReactSettings = settingsController;
  window.__wandReactNewSession = newSessionController;
  window.__wandReactFolderPicker = folderPickerController;
  window.__wandReactQuickCommit = quickCommitController;
  window.__wandReactWorktreeMerge = worktreeMergeController;
  window.__wandReactRestartOverlay = restartOverlayController;
  window.__wandReactFilePreview = filePreviewController;
  window.__wandReactMissions = missionsController;
  window.__wandReactWorkspaces = workspacesController;
}

/**
 * Mounts the stable business-overlay infrastructure next to legacy #app.
 *
 * `reactUi=0` rolls the authenticated Shell and generic dialog/toast bridge
 * back, but the migrated business overlays remain mounted because they have
 * no legacy implementation. This prevents their public adapters from
 * reporting a successful open while no Host exists to render it.
 */
export function startReactUi(): WandOverlay | null {
  const overlayRoot = getOrCreateOverlayRoot();
  const genericUiEnabled = isReactUiEnabled();

  if (!activeRoot) {
    installReactUiStyles();
    const mount = getOrCreateChild(overlayRoot, REACT_MOUNT_ID, "wand-ui-mount");
    const portals = getOrCreateChild(overlayRoot, PORTAL_CONTAINER_ID, "wand-ui-portals");
    activeRoot = createRoot(mount);
    activeRoot.render(<OverlayHost portalContainer={portals} />);
  }

  exposeBusinessControllers();
  overlayRoot.dataset.reactUi = genericUiEnabled ? "enabled" : "fallback";
  if (!genericUiEnabled) {
    // Keep native confirm/prompt and the legacy notification bubble as the
    // explicit generic fallback while business controllers retain real Hosts.
    delete window.__wandReactUi;
    return null;
  }

  window.__wandReactUi = wandOverlay;
  return wandOverlay;
}


export {WandOverlay} from "./overlay-controller";
export {isReactShellEnabled} from "./feature-flags";


export {configureNewSessionRuntime} from "./new-session/controller";
export {configureFolderPickerRuntime, folderPickerController} from "./folder-picker/controller";







export {NewSessionCreateRequest, NewSessionCreated, NewSessionRuntimeAdapter} from "./new-session/types";
export {FolderPickerRuntimeAdapter} from "./folder-picker/types";




export * from "./shell";
export * from "./ui";
