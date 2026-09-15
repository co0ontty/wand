import {
  Navigation,
  NavigationItem,
  NavigationLink,
  NavigationList,
  type NavigationLinkProps,
} from "@appica/ui-react/navigation";
import * as React from "react";
import { classNames, staticClassName } from "./class-names";

/**
 * Wand's navigation list, rendered by Appica UI.
 *
 * The `wand-ui-navigation*` classes are stable styling hooks for the business
 * stylesheets. They carry no visuals of their own: Appica's `pill` variant owns
 * the row geometry (padding, radius, text size) and the hover/active wash, and
 * its `data-active` state replaces Wand's old `[aria-current="page"]` rules.
 *
 * `NavigationLink` renders an `<a>` by default; Wand's rows are buttons that
 * dispatch UI actions, so callers pass `render={<button ... />}`.
 */
/** Appica's navigation context types are not re-exported by the subpath, so the
 * two literal unions Wand actually passes through live here. */
export type WandNavigationOrientation = "horizontal" | "vertical";
export type WandNavigationVariant = "pill" | "line" | "indicator";

export interface WandNavigationProps
  extends Omit<React.ComponentProps<"nav">, "onChange"> {
  readonly active?: string | number | null;
  readonly orientation?: WandNavigationOrientation;
  readonly variant?: WandNavigationVariant;
  readonly size?: "sm" | "md" | "lg";
}

export function WandNavigation({
  className,
  active = null,
  orientation = "vertical",
  variant = "pill",
  size = "md",
  ...props
}: WandNavigationProps) {
  const merged = classNames("wand-ui-navigation", staticClassName(className));
  // Appica's props are a discriminated union on `orientation` (the `indicator`
  // variant only exists vertically), so the two branches are written out
  // instead of spreading a widened `orientation` variable.
  if (orientation === "vertical") {
    return (
      <Navigation
        {...props}
        orientation="vertical"
        variant={variant}
        size={size}
        activeLink={active}
        className={merged}
      />
    );
  }
  return (
    <Navigation
      {...props}
      orientation="horizontal"
      variant={variant === "indicator" ? "pill" : variant}
      size={size}
      activeLink={active}
      className={merged}
    />
  );
}

export function WandNavigationList({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <NavigationList
      {...props}
      className={classNames("wand-ui-navigation-list", staticClassName(className))}
    />
  );
}

export function WandNavigationItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <NavigationItem
      {...props}
      className={classNames("wand-ui-navigation-item", staticClassName(className))}
    />
  );
}

export interface WandNavigationLinkProps extends NavigationLinkProps {
  readonly className?: string;
}

export function WandNavigationLink({
  className,
  ...props
}: WandNavigationLinkProps) {
  return (
    <NavigationLink
      {...props}
      className={classNames("wand-ui-navigation-link", staticClassName(className))}
    />
  );
}
