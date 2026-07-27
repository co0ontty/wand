import * as ToastPrimitive from "@radix-ui/react-toast";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { classNames } from "./class-names";
import { usePortalContainer } from "./portal-context";

export type WandToastTone = "info" | "success" | "warning" | "error";

export interface WandToastItemProps {
  open: boolean;
  title: string;
  description?: string;
  tone?: WandToastTone;
  duration?: number;
  onDismiss(): void;
}

export interface WandToastRegionProps {
  children: ReactNode;
}

export function WandToastRegion({ children }: WandToastRegionProps) {
  const portalContainer = usePortalContainer();
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="通知">
      {children}
      {portalContainer
        ? createPortal(
            <ToastPrimitive.Viewport className="wand-ui-toast-viewport" />,
            portalContainer,
          )
        : null}
    </ToastPrimitive.Provider>
  );
}

export function WandToastItem({
  open,
  title,
  description,
  tone = "info",
  duration = 3200,
  onDismiss,
}: WandToastItemProps) {
  return (
    <ToastPrimitive.Root
      open={open}
      duration={duration}
      className={classNames("wand-ui-toast", `wand-ui-toast-${tone}`)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss();
      }}
    >
      <ToastPrimitive.Title className="wand-ui-toast-title">{title}</ToastPrimitive.Title>
      {description ? (
        <ToastPrimitive.Description className="wand-ui-toast-description">
          {description}
        </ToastPrimitive.Description>
      ) : null}
      <ToastPrimitive.Close className="wand-ui-toast-close" aria-label="关闭通知">
        ×
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
