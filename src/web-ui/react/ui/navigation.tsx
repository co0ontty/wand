import * as React from "react";
import { classNames } from "./class-names";
import { WandButton } from "./button";

export type WandNavigationOrientation = "horizontal" | "vertical";
export type WandNavigationVariant = "pill" | "line" | "indicator";
export interface WandNavigationProps extends Omit<React.ComponentProps<"nav">, "onChange"> {
  active?: string | number | null;
  orientation?: WandNavigationOrientation;
  variant?: WandNavigationVariant;
  size?: "sm" | "md" | "lg";
}
const NavigationActive = React.createContext<string | number | null>(null);
export function WandNavigation({ className, active = null, orientation = "vertical", variant: _variant, size: _size, children, ...props }: WandNavigationProps) {
  return <NavigationActive.Provider value={active}><nav {...props} className={classNames("wand-ui-navigation", className)} data-orientation={orientation}>{children}</nav></NavigationActive.Provider>;
}
export function WandNavigationList({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul {...props} className={classNames("wand-ui-navigation-list", className)}/>;
}
export function WandNavigationItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li {...props} className={classNames("wand-ui-navigation-item", className)}/>;
}
export interface WandNavigationLinkProps extends Omit<React.ComponentPropsWithRef<"button">, "size"> {
  render?: React.ReactElement<React.ComponentPropsWithRef<"button">>;
  active?: boolean;
  variant?: WandNavigationVariant;
  indicator?: React.ReactNode;
  href?: string;
  target?: string;
  rel?: string;
  value?: string | number;
  orientation?: WandNavigationOrientation;
  size?: "sm" | "md" | "lg";
}
export function WandNavigationLink({ className, render, active, value, orientation: _orientation, size = "md", variant: _variant, indicator, children, ...props }: WandNavigationLinkProps) {
  const current = React.useContext(NavigationActive);
  const selected = active ?? (value != null && value === current);
  return <WandButton {...render?.props} {...props} className={classNames("wand-ui-navigation-link", render?.props.className, className)}
    kind={selected ? "soft" : "ghost"} data-active={selected ? "" : undefined}
    aria-current={selected ? "page" : undefined} size={size === "sm" ? "small" : size === "lg" ? "large" : "medium"}>{children ?? render?.props.children}{indicator}</WandButton>;
}
