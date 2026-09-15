import {
  DropdownMenu as AppicaDropdownMenu,
  DropdownMenuContent as AppicaDropdownMenuContent,
  DropdownMenuItem as AppicaDropdownMenuItem,
  DropdownMenuSeparator as AppicaDropdownMenuSeparator,
  DropdownMenuTrigger as AppicaDropdownMenuTrigger,
  type DropdownMenuContentProps as AppicaDropdownMenuContentProps,
  type DropdownMenuItemProps as AppicaDropdownMenuItemProps,
  type DropdownMenuProps as AppicaDropdownMenuProps,
  type DropdownMenuSeparatorProps as AppicaDropdownMenuSeparatorProps,
  type DropdownMenuTriggerProps as AppicaDropdownMenuTriggerProps,
} from "@appica/ui-react/dropdown-menu";
import * as React from "react";
import { classNames, staticClassName } from "./class-names";
import { WandIcon, type WandIconName, type WandIconSlot } from "./icons";
import { usePortalContainer } from "./portal-context";

/**
 * Wand's action menu, rendered by Appica UI's DropdownMenu (Base UI Menu).
 *
 * Replaces the hand-rolled `WandPopover` + `.topbar-more-item` /
 * `.overflow-item` rows: the library owns the popup chrome, the item
 * geometry, roving focus, typeahead and the open/close motion, so every menu
 * in the app now behaves and looks the same.
 *
 * `wand-ui-dropdown-*` is the business hook for the few places Wand still
 * needs to size a specific panel.
 */
export interface WandDropdownMenuProps extends Omit<AppicaDropdownMenuProps, "children"> {
  readonly children: React.ReactNode;
}

export function WandDropdownMenu({ children, ...props }: WandDropdownMenuProps) {
  return <AppicaDropdownMenu {...props}>{children}</AppicaDropdownMenu>;
}

export interface WandDropdownMenuTriggerProps
  extends Omit<AppicaDropdownMenuTriggerProps, "className"> {
  readonly className?: string;
}

export function WandDropdownMenuTrigger({ className, ...props }: WandDropdownMenuTriggerProps) {
  return (
    <AppicaDropdownMenuTrigger
      {...props}
      className={classNames("wand-ui-dropdown-trigger", staticClassName(className))}
    />
  );
}

export interface WandDropdownMenuContentProps
  extends Omit<AppicaDropdownMenuContentProps, "className"> {
  readonly className?: string;
}

export function WandDropdownMenuContent({
  className,
  container,
  ...props
}: WandDropdownMenuContentProps) {
  const portalContainer = usePortalContainer();
  return (
    <AppicaDropdownMenuContent
      {...props}
      container={container ?? portalContainer}
      className={classNames("wand-ui-dropdown-content", staticClassName(className))}
    />
  );
}

export interface WandDropdownMenuItemProps
  extends Omit<AppicaDropdownMenuItemProps, "className" | "children"> {
  readonly className?: string;
  readonly icon?: WandIconName;
  /** Which side of the label the icon sits on; Appica pads by `data-icon`. */
  readonly iconSlot?: WandIconSlot;
  /** Trailing secondary text (count, state). */
  readonly hint?: React.ReactNode;
  readonly tone?: "default" | "danger";
  readonly children: React.ReactNode;
}

export function WandDropdownMenuItem({
  className,
  icon,
  iconSlot = "start",
  hint,
  tone = "default",
  children,
  ...props
}: WandDropdownMenuItemProps) {
  return (
    <AppicaDropdownMenuItem
      {...props}
      className={classNames(
        "wand-ui-dropdown-item",
        tone === "danger" && "wand-ui-dropdown-item-danger",
        staticClassName(className),
      )}
    >
      {icon ? <WandIcon name={icon} slot={iconSlot} size={15}/> : null}
      <span className="wand-ui-dropdown-item-label">{children}</span>
      {hint != null ? <span className="wand-ui-dropdown-item-hint">{hint}</span> : null}
    </AppicaDropdownMenuItem>
  );
}

export interface WandDropdownMenuSeparatorProps
  extends Omit<AppicaDropdownMenuSeparatorProps, "className"> {
  readonly className?: string;
}

export function WandDropdownMenuSeparator({ className, ...props }: WandDropdownMenuSeparatorProps) {
  return (
    <AppicaDropdownMenuSeparator
      {...props}
      className={classNames("wand-ui-dropdown-separator", staticClassName(className))}
    />
  );
}
