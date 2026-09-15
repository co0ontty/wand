import { Chip as AppicaChip, type ChipProps as AppicaChipProps } from "@appica/ui-react/chip";
import * as React from "react";
import { classNames, staticClassName } from "./class-names";

/**
 * Wand's compact inline action pill, rendered by Appica UI.
 *
 * `wand-ui-chip` is the business hook; Appica owns the height, radius, type
 * scale and the soft/hover wash.
 */
export interface WandChipProps extends Omit<AppicaChipProps, "className"> {
  readonly className?: string;
}

export function WandChip({ className, ...props }: WandChipProps) {
  return (
    <AppicaChip
      {...props}
      className={classNames("wand-ui-chip", staticClassName(className))}
    />
  );
}
