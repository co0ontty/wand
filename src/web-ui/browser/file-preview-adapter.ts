import { folderPickerController } from "../react/folder-picker/controller";
import {
  configureFilePreviewRuntime,
  filePreviewController,
  filePreviewStore,
} from "../react/file-preview/controller";
import { newSessionController } from "../react/new-session/controller";
import { quickCommitController } from "../react/quick-commit/controller";
import { restartOverlayController } from "../react/restart-overlay/controller";
import { settingsController } from "../react/settings/controller";
import { worktreeMergeController } from "../react/worktree-merge/controller";
import type {
  FilePreviewDiscardReason,
  FilePreviewNoticeTone,
  FilePreviewSibling,
} from "../react/file-preview/types";

export interface LegacyFilePreviewItem {
  path?: unknown;
  name?: unknown;
  type?: unknown;
}

export interface FilePreviewLegacyAdapterDependencies {
  getSiblings(): ReadonlyArray<LegacyFilePreviewItem>;
  confirmDiscard(reason: FilePreviewDiscardReason, path: string): Promise<boolean>;
  copyText(text: string): boolean | Promise<boolean>;
  appendToComposer(text: string): boolean;
  notify(message: string, tone: FilePreviewNoticeTone): void;
  onSaved(path: string): void | Promise<void>;
}

let activeDependencies: FilePreviewLegacyAdapterDependencies | null = null;
let disposeRuntime: (() => void) | null = null;
let competingClose: Promise<boolean> | null = null;
let pendingCompetingIntent: (() => void) | null = null;

function normalizeSiblings(items: ReadonlyArray<LegacyFilePreviewItem>): FilePreviewSibling[] {
  const siblings: FilePreviewSibling[] = [];
  for (const item of items) {
    if (item.type !== "file" || typeof item.path !== "string" || !item.path.trim()) continue;
    siblings.push({
      path: item.path,
      ...(typeof item.name === "string" && item.name ? { name: item.name } : {}),
      type: "file",
    });
  }
  return siblings;
}

function closeCompetingReactOverlays(): boolean {
  const controllers = [
    quickCommitController,
    folderPickerController,
    newSessionController,
    worktreeMergeController,
    settingsController,
  ];
  for (const controller of controllers) {
    if (controller.isOpen() && !controller.closeIfOpen()) return false;
  }
  return true;
}

export function installFilePreviewLegacyAdapter(
  dependencies: FilePreviewLegacyAdapterDependencies,
): () => void {
  disposeRuntime?.();
  activeDependencies = dependencies;
  disposeRuntime = configureFilePreviewRuntime({
    confirmDiscard: dependencies.confirmDiscard,
    async copyText(text): Promise<void> {
      if (!await dependencies.copyText(text)) throw new Error("复制失败。");
    },
    appendToComposer: dependencies.appendToComposer,
    notify: dependencies.notify,
    onSaved: dependencies.onSaved,
  });

  let disposed = false;
  return () => {
    if (disposed || activeDependencies !== dependencies) return;
    disposed = true;
    pendingCompetingIntent = null;
    filePreviewController.closeIfOpen();
    disposeRuntime?.();
    disposeRuntime = null;
    activeDependencies = null;
  };
}

export function openFilePreviewFromLegacy(path: string): boolean {
  const dependencies = activeDependencies;
  const normalizedPath = typeof path === "string" ? path.trim() : "";
  if (!dependencies || !normalizedPath) return false;
  if (restartOverlayController.isOpen()) return false;
  if (!closeCompetingReactOverlays()) return false;
  void filePreviewController.open({
    path: normalizedPath,
    siblings: normalizeSiblings(dependencies.getSiblings()),
  });
  return true;
}

export function closeFilePreviewFromLegacy(): boolean {
  return filePreviewController.closeIfOpen();
}

/**
 * Returns whether another overlay may open synchronously. Clean previews close
 * before this function returns. Dirty previews retain the latest open intent
 * and continue it automatically only after the user confirms discard.
 */
export function prepareFilePreviewForCompetingOverlay(openIntent: () => void): boolean {
  if (!filePreviewController.isOpen()) return true;
  const snapshot = filePreviewStore.getSnapshot();
  if (snapshot.saving) return false;
  if (!snapshot.dirty) {
    filePreviewController.closeIfOpen();
    return !filePreviewController.isOpen();
  }

  pendingCompetingIntent = openIntent;
  if (!competingClose) {
    competingClose = filePreviewController.execute({ type: "close" });
    void competingClose.then((closed) => {
      const intent = pendingCompetingIntent;
      pendingCompetingIntent = null;
      competingClose = null;
      if (!closed || !intent) return;
      try {
        intent();
      } catch (error) {
        console.warn("[wand] Failed to continue overlay open intent", error);
      }
    });
  }
  return false;
}
