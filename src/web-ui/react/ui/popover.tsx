import { Popover, type PopoverProps } from "antd";
import * as React from "react";
import type { AriaRole, ReactElement, ReactNode } from "react";
import { classNames } from "./class-names";
import { usePortalContainer } from "./portal-context";
import { popupPlacement, popupOffset, usePopupDismiss } from "./popup-lifecycle";
import { WandUiBoundary } from "../theme";

export interface WandPopoverProps {
  trigger: ReactElement;
  triggerActions?: PopoverProps["trigger"];
  children: ReactNode;
  ariaLabel?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  className?: string;
  open?: boolean;
  contentId?: string;
  popupOwner?: string;
  contentRole?: AriaRole;
  onOpenChange?(open: boolean): void;
}
export function WandPopover({ trigger, triggerActions = "click", children, ariaLabel, align = "center", side = "bottom", sideOffset = 8,
  className, open, contentId, contentRole, popupOwner = contentId ?? ariaLabel, onOpenChange }: WandPopoverProps) {
  const portal = usePortalContainer();
  const triggerRef = React.useRef<React.ComponentRef<typeof Popover>>(null);
  const [internalOpen, setInternalOpen] = React.useState(false);
  const shown = open ?? internalOpen;
  const change = (next: boolean): void => { setInternalOpen(next); onOpenChange?.(next); };
  usePopupDismiss(shown, () => { change(false); triggerRef.current?.nativeElement?.focus({ preventScroll: true }); });
  return <WandUiBoundary><Popover ref={triggerRef} open={shown} onOpenChange={change} trigger={triggerActions} arrow={false}
    placement={popupPlacement(side, align)} destroyOnHidden getPopupContainer={() => portal ?? document.body}
    align={{ offset: popupOffset(side, sideOffset) }}
    classNames={{ root: classNames("wand-ui-popover-content", className) }}
    content={<div id={contentId} role={contentRole} aria-label={ariaLabel} data-wand-popup-owner={popupOwner}>{children}</div>}>
    {trigger}
  </Popover></WandUiBoundary>;
}
