import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import type { AriaRole, ReactElement, ReactNode } from "react";
import { classNames } from "./class-names";
import { usePortalContainer } from "./portal-context";

export interface WandPopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  ariaLabel?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  className?: string;
  open?: boolean;
  contentId?: string;
  contentRole?: AriaRole;
  forceMount?: true;
  portalled?: boolean;
  showArrow?: boolean;
  onOpenChange?(open: boolean): void;
}

export function WandPopover({
  trigger,
  children,
  ariaLabel,
  align = "center",
  side = "bottom",
  sideOffset = 8,
  className,
  open,
  contentId,
  contentRole,
  forceMount,
  portalled = true,
  showArrow = true,
  onOpenChange,
}: WandPopoverProps) {
  const portalContainer = usePortalContainer();
  const content = (
    <PopoverPrimitive.Content
      id={contentId}
      role={contentRole}
      forceMount={forceMount}
      className={classNames("wand-ui-popover-content", className)}
      aria-label={ariaLabel}
      align={align}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={12}
    >
      {children}
      {showArrow ? <PopoverPrimitive.Arrow className="wand-ui-popover-arrow" /> : null}
    </PopoverPrimitive.Content>
  );
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      {portalled ? (
        <PopoverPrimitive.Portal container={portalContainer}>{content}</PopoverPrimitive.Portal>
      ) : content}
    </PopoverPrimitive.Root>
  );
}
