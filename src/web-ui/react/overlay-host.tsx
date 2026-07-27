import { useSyncExternalStore } from "react";
import { overlayStore } from "./overlay-controller";
import {
  PortalContainerProvider,
  WandDialog,
  WandToastItem,
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
      <SettingsHost showRestart={() => restartOverlayController.showRestart()} />
      <NewSessionHost />
      <FolderPickerHost />
      <QuickCommitHost />
      <WorktreeMergeHost />
      <FilePreviewHost />
      <RestartOverlayHost />
      <WandToastRegion>
        {current.toasts.map((toast) => (
          <WandToastItem
            key={toast.id}
            open={toast.open}
            title={toast.message}
            description={toast.options.description}
            tone={toast.options.tone}
            duration={toast.options.duration}
            onDismiss={() => overlayStore.dismissToast(toast.id)}
          />
        ))}
      </WandToastRegion>

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
