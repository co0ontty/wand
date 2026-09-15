import { Badge, type BadgeProps } from "@appica/ui-react/badge";
import * as React from "react";
import { classNames } from "./class-names";

type WandBadgeTone = "neutral" | "accent" | "info" | "success" | "warning";

/** Wand's semantic tones. Appica only supplies the tinted "soft" chrome;
 *  the tone colours themselves come from the `wand-ui-badge-<tone>` hooks in
 *  react/styles/base.ts, because Appica's role variants pair a tint fill with
 *  `*-foreground`, which in Wand's palette is the on-solid (white) colour. */
const TONE_VARIANTS = {
  neutral: "soft",
  accent: "soft",
  info: "soft",
  success: "soft",
  warning: "soft",
} as const satisfies Record<WandBadgeTone, NonNullable<BadgeProps["variant"]>>;

export interface WandBadgeProps extends Omit<BadgeProps, "variant" | "tone"> {
  tone?: WandBadgeTone;
}

export function WandBadge({ className, tone = "neutral", size = "sm", ...props }: WandBadgeProps) {
  return (
    <Badge
      {...props}
      size={size}
      variant={TONE_VARIANTS[tone]}
      className={classNames(
        /* `tabular-nums`: badges are mostly counts/percentages, and proportional
           digits make their width jitter as the value changes. */
        "wand-ui-badge tabular-nums",
        `wand-ui-badge-${tone}`,
        className,
      )}
    />
  );
}
