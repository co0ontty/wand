import { type ComponentPropsWithoutRef } from "react";
import { classNames } from "./class-names";

export type WandBadgeTone = "neutral" | "accent" | "info" | "success" | "warning";

export interface WandBadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: WandBadgeTone;
}

export function WandBadge({
  className,
  tone = "neutral",
  ...props
}: WandBadgeProps) {
  return (
    <span
      {...props}
      className={classNames("wand-ui-badge", `wand-ui-badge-${tone}`, className)}
    />
  );
}
