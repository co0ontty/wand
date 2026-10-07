import { Button, type ButtonProps } from "antd";
import * as React from "react";
import { classNames } from "./class-names";
import { WandUiBoundary } from "../theme";

export type WandButtonKind = "primary" | "secondary" | "outline" | "soft" | "ghost" | "danger";
type WandButtonSize = "small" | "medium" | "large";
export interface WandButtonProps extends Omit<React.ComponentPropsWithRef<"button">, "className" | "color"> {
  className?: string;
  kind?: WandButtonKind;
  size?: WandButtonSize;
  loading?: ButtonProps["loading"];
  href?: string;
  target?: string;
  rel?: string;
}
export interface WandIconButtonProps extends WandButtonProps { children: React.ReactNode; }

export function WandButton({ className, kind = "secondary", size = "medium", type = "button", ref, ...props }: WandButtonProps) {
  return <WandUiBoundary><Button {...props} ref={ref} htmlType={type}
    type={kind === "soft" ? undefined : kind === "primary" || kind === "danger" ? "primary" : kind === "ghost" ? "text" : "default"}
    color={kind === "soft" ? "default" : undefined} danger={kind === "danger"} variant={kind === "soft" ? "filled" : undefined}
    size={size === "medium" ? "middle" : size}
    className={classNames("wand-ui-button", `wand-ui-button-${kind}`, size !== "medium" && `wand-ui-button-${size}`, className)}/></WandUiBoundary>;
}

export function WandIconButton({ className, kind = "ghost", size = "small", children, ...props }: WandIconButtonProps) {
  return <WandButton {...props} kind={kind} size={size} className={classNames("wand-ui-icon-button", className)}>{children}</WandButton>;
}
