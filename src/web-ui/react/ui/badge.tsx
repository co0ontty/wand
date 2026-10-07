import { Tag } from "antd";
import * as React from "react";
import { classNames } from "./class-names";
import { WandUiBoundary } from "../theme";

type WandBadgeTone = "neutral" | "accent" | "info" | "success" | "warning";
export interface WandBadgeProps extends React.ComponentPropsWithRef<"span"> {
  tone?: WandBadgeTone;
  size?: "xs" | "sm" | "md" | "lg" | "icon-sm" | "icon-md" | "icon-lg";
}
const colors = { neutral: undefined, accent: "#b8562f", info: "processing", success: "success", warning: "warning" };
export function WandBadge({ className, tone = "neutral", size: _size, ...props }: WandBadgeProps) {
  return <WandUiBoundary><Tag {...props} color={colors[tone]} className={classNames("wand-ui-badge", `wand-ui-badge-${tone}`, className)}/></WandUiBoundary>;
}
