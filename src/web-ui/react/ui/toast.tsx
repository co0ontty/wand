import {
  Toast as AppicaToast,
  ToastClose as AppicaToastClose,
  ToastDescription as AppicaToastDescription,
  ToastPortal as AppicaToastPortal,
  ToastProvider as AppicaToastProvider,
  ToastTitle as AppicaToastTitle,
  ToastViewport as AppicaToastViewport,
  createToastManager,
  useToastManager,
} from "@appica/ui-react/toast";
import * as React from "react";
import { classNames } from "./class-names";
import { usePortalContainer } from "./portal-context";

export type WandToastTone = "info" | "success" | "warning" | "error";

interface WandToastData {
  tone?: WandToastTone;
}

export interface WandToastOptions {
  description?: string;
  tone?: WandToastTone;
  duration?: number;
}

/** Wand's default auto-dismiss; the old hand-rolled stack used the same value. */
const TOAST_DURATION = 3200;

/**
 * Appica drives toasts from a manager rather than from React state, which is
 * exactly what Wand needs: `wandOverlay.toast()` is called from plain browser
 * modules (legacy overlays, editors, file explorer) that have no component to
 * hook into. The provider below subscribes to this same manager, so a toast
 * queued before React is even mounted still shows up.
 */
const toastManager = createToastManager<WandToastData>();

export interface WandToastHandle {
  readonly id: string;
  dismiss(): void;
}

export function showWandToast(message: string, options: WandToastOptions = {}): WandToastHandle {
  const id = toastManager.add({
    title: message,
    description: options.description,
    timeout: options.duration ?? TOAST_DURATION,
    data: { tone: options.tone },
  });
  return { id, dismiss: () => toastManager.close(id) };
}

/**
 * Wand's toast stack, rendered by Appica UI.
 *
 * Appica only ships the manager-driven `Toaster` as a whole; Wand needs a tone
 * per toast (`wand-ui-toast-<tone>`) plus its own surface styling, so the
 * viewport is composed from the same parts the library's `Toaster` uses.
 */
export function WandToastRegion() {
  const portalContainer = usePortalContainer();
  return (
    <AppicaToastProvider toastManager={toastManager} timeout={TOAST_DURATION}>
      <AppicaToastPortal container={portalContainer}>
        <WandToastViewport />
      </AppicaToastPortal>
    </AppicaToastProvider>
  );
}

function WandToastViewport() {
  const { toasts } = useToastManager<WandToastData>();
  return (
    <AppicaToastViewport position="top-right" className="wand-ui-toast-viewport">
      {toasts.map((toast) => (
        <AppicaToast
          key={toast.id}
          toast={toast}
          position="top-right"
          className={classNames("wand-ui-toast", `wand-ui-toast-${toast.data?.tone ?? "info"}`)}
        >
          <AppicaToastTitle className="wand-ui-toast-title">{toast.title}</AppicaToastTitle>
          {toast.description ? (
            <AppicaToastDescription className="wand-ui-toast-description">
              {toast.description}
            </AppicaToastDescription>
          ) : null}
          <AppicaToastClose className="wand-ui-toast-close" closeLabel="关闭通知"/>
        </AppicaToast>
      ))}
    </AppicaToastViewport>
  );
}
