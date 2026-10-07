import * as React from "react";
import { createRoot } from "react-dom/client";
import type { OverlayDialogOptions, OverlayDialogResult } from "./overlay-controller";
import { WandDialog } from "./ui/dialog";
import { documentPortalContainer, PortalContainerProvider } from "./ui/portal-context";
import { wandTheme, WandUiProvider } from "./theme";
import { installReactUiStyles } from "./styles";

// The rollback/startup path owns its root without enabling the generic bridge.
// The same canonical dialog supplies library focus, keyboard, input and styling.
let pending = Promise.resolve();
let dismissActive: (() => void) | null = null;

export function openOwnedDialog<T>(options: OverlayDialogOptions<T>): Promise<OverlayDialogResult<T>> {
  const result = pending.then(() => new Promise<OverlayDialogResult<T>>((resolve, reject) => {
    installReactUiStyles();
    const host = document.createElement("div");
    host.dataset.wandOwnedDialogRoot = "";
    document.body.appendChild(host);
    const mount = document.createElement("div");
    host.appendChild(mount);
    const sharedPortal = documentPortalContainer();
    const portals = sharedPortal ?? document.createElement("div");
    if (!sharedPortal) {
      // Startup owns a temporary portal; a mounted Shell already supplies the
      // common stacking context and must keep ownership of its container.
      portals.className = "wand-ui-portals";
      portals.style.zIndex = String(wandTheme.token?.zIndexPopupBase ?? 20010);
      host.appendChild(portals);
    }
    let settled = false;
    const root = createRoot(mount, { onUncaughtError: error => finish(undefined, error) });
    const finish = (outcome?: OverlayDialogResult<T>, error?: unknown): void => {
      if (settled) return;
      settled = true; dismissActive = null;
      queueMicrotask(() => {
        root.unmount(); host.remove();
        if (error) reject(error); else resolve(outcome!);
      });
    };
    dismissActive = () => { if (options.dismissable !== false) finish({ dismissed: true }); };
    root.render(<PortalContainerProvider container={portals}><WandUiProvider><WandDialog open title={options.title} description={options.description}
      tone={options.tone} icon={options.icon} actions={options.actions} input={options.input}
      dismissable={options.dismissable}
      onAction={(action, inputValue) => finish({ dismissed: false, action, inputValue })}
      onDismiss={() => finish({ dismissed: true })}/></WandUiProvider></PortalContainerProvider>);
  }));
  pending = result.then(() => undefined, () => undefined);
  return result;
}

/** Consume native back while this root owns a dialog, including guarded dialogs. */
export function closeOwnedDialog(): boolean {
  if (!dismissActive) return false;
  dismissActive(); return true;
}
