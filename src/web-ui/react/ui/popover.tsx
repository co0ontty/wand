import {
  Popover as AppicaPopover,
  PopoverContent as AppicaPopoverContent,
  PopoverTrigger as AppicaPopoverTrigger,
} from "@appica/ui-react/popover";
import * as React from "react";
import type { AriaRole, ReactElement, ReactNode } from "react";
import { classNames, staticClassName } from "./class-names";
import { usePortalContainer } from "./portal-context";

void React;

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
  onOpenChange?(open: boolean): void;
}

/**
 * Wand's floating panel, rendered by Appica UI's Popover.
 *
 * Appica always portals the popup into the overlay root - the same floating
 * surface Select, Combobox and DropdownMenu use - so there is no non-portalled
 * mode left. Business code that used to keep a panel mounted and hidden with
 * CSS now relies on the popover mounting it only while open.
 *
 * `wand-ui-popover-content` remains as the styling hook business stylesheets
 * hang their panel sizing off; the chrome (border, radius, shadow, backdrop,
 * enter/exit motion) comes from the library.
 */
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
  onOpenChange,
}: WandPopoverProps) {
  const portalContainer = usePortalContainer();
  return (
    <AppicaPopover open={open} onOpenChange={onOpenChange}>
      <AppicaPopoverTrigger render={trigger}/>
      <AppicaPopoverContent
        id={contentId}
        role={contentRole}
        aria-label={ariaLabel}
        container={portalContainer}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        arrow={false}
        className={classNames("wand-ui-popover-content", staticClassName(className))}
      >
        {children}
      </AppicaPopoverContent>
    </AppicaPopover>
  );
}
