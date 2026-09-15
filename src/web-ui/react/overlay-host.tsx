import { useSyncExternalStore } from "react";
import * as React from "react";
import { overlayStore } from "./overlay-controller";
import {
  PortalContainerProvider,
  WandDialog,
  WandToastRegion,
} from "./ui";
import { SettingsHost } from "./settings/host";
import { NewSessionHost } from "./new-session/host";
import { FolderPickerHost } from "./folder-picker/host";
import { QuickCommitHost } from "./quick-commit/host";
import { WorktreeMergeHost } from "./worktree-merge/host";
import { RestartOverlayHost } from "./restart-overlay/host";
import { restartOverlayController } from "./restart-overlay/controller";
import { FilePreviewHost } from "./file-preview/host";
import { LocalPreviewHost } from "./local-preview/host";
import { ComposerSelectHost } from "./composer-select/host";
import { ComposerRailHost } from "./composer-rail/host";
import { MissionsHost } from "./missions/host";
import { WorkspacesHost } from "./workspaces/host";
import { GithubIssuesHost } from "./issues/host";

export interface OverlayHostProps {
  portalContainer: HTMLElement;
}

export function OverlayHost({ portalContainer }: OverlayHostProps) {
  const current = useSyncExternalStore(
    overlayStore.subscribe,
    overlayStore.getSnapshot,
    overlayStore.getSnapshot,
  );
  const dialog = current.activeDialog;

  return (
    <PortalContainerProvider container={portalContainer}>
      <ComposerSelectHost />
      <ComposerRailHost />
      <MissionsHost />
      <WorkspacesHost />
      <GithubIssuesHost />
      <SettingsHost showRestart={() => restartOverlayController.showRestart()} />
      <NewSessionHost />
      <FolderPickerHost />
      <QuickCommitHost />
      <WorktreeMergeHost />
      <FilePreviewHost />
      <LocalPreviewHost />
      <RestartOverlayHost />
      <WandToastRegion />

      {dialog ? (
        <WandDialog
          key={dialog.id}
          open
          title={dialog.options.title}
          description={dialog.options.description}
          tone={dialog.options.tone}
          icon={dialog.options.icon}
          actions={dialog.options.actions}
          input={dialog.options.input}
          dismissable={dialog.options.dismissable}
          onAction={(action, inputValue) => {
            overlayStore.completeDialog(dialog.id, {
              dismissed: false,
              action,
              inputValue,
            });
          }}
          onDismiss={() => {
            overlayStore.completeDialog(dialog.id, { dismissed: true });
          }}
        />
      ) : null}
    </PortalContainerProvider>
  );
}
