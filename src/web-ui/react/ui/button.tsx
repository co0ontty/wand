import { Button as AppicaButton, type ButtonProps as AppicaButtonProps } from "@appica/ui-react/button";
import * as React from "react";
import { classNames, staticClassName } from "./class-names";

export type WandButtonKind = "primary" | "secondary" | "outline" | "soft" | "ghost" | "danger";
type WandButtonSize = "small" | "medium" | "large";

/**
 * Wand's button surface, rendered by Appica UI.
 *
 * The `wand-ui-button*` classes are kept as stable styling hooks for the
 * business stylesheets (`.task-board-create-footer .wand-ui-button { ... }`
 * and friends). They no longer carry visuals - Appica's Tailwind classes and
 * design tokens own the appearance.
 */
export interface WandButtonProps extends Omit<AppicaButtonProps, "variant" | "size"> {
  kind?: WandButtonKind;
  size?: WandButtonSize;
}

export interface WandIconButtonProps
  extends Omit<AppicaButtonProps, "variant" | "size" | "children"> {
  kind?: WandButtonKind;
  size?: WandButtonSize;
  children: React.ReactNode;
}

const KIND_TO_VARIANT: Record<WandButtonKind, AppicaButtonProps["variant"]> = {
  primary: "primary",
  secondary: "secondary",
  outline: "outline",
  soft: "soft",
  ghost: "ghost",
  danger: "destructive",
};

const SIZE_TO_APPICA: Record<WandButtonSize, AppicaButtonProps["size"]> = {
  small: "sm",
  medium: "md",
  large: "lg",
};

/**
 * Icon-only buttons use Appica's square `icon-*` sizes. The visible label is
 * the SVG itself, so callers must keep passing `aria-label` / `title`.
 */
const ICON_SIZE_TO_APPICA: Record<WandButtonSize, AppicaButtonProps["size"]> = {
  small: "icon-sm",
  medium: "icon-md",
  large: "icon-lg",
};

export function WandIconButton({
  className,
  kind = "ghost",
  size = "small",
  type = "button",
  ...props
}: WandIconButtonProps) {
  return (
    <AppicaButton
      {...props}
      type={type}
      variant={KIND_TO_VARIANT[kind]}
      size={ICON_SIZE_TO_APPICA[size]}
      className={classNames(
        "wand-ui-button",
        `wand-ui-button-${kind}`,
        "wand-ui-icon-button",
        staticClassName(className),
      )}
    />
  );
}

export function WandButton({
  className,
  kind = "secondary",
  size = "medium",
  type = "button",
  ...props
}: WandButtonProps) {
  return (
    <AppicaButton
      {...props}
      type={type}
      variant={KIND_TO_VARIANT[kind]}
      size={SIZE_TO_APPICA[size]}
      className={classNames(
        "wand-ui-button",
        `wand-ui-button-${kind}`,
        size !== "medium" && `wand-ui-button-${size}`,
        staticClassName(className),
      )}
    />
  );
}
