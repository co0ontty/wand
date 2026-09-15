import { Input as AppicaInput, type InputProps as AppicaInputProps } from "@appica/ui-react/input";
import * as React from "react";
import { classNames, staticClassName } from "./class-names";

/**
 * Wand's text field, rendered by Appica UI.
 *
 * `wand-ui-input` is the business hook; Appica owns the frame (radius, border,
 * height per `size`) and the focus ring. `startSlot` / `endSlot` are Appica's
 * inline adornments - Wand's old absolutely positioned icons are gone.
 */
export interface WandInputProps
  extends Omit<AppicaInputProps, "className"> {
  readonly className?: string;
}

export function WandInput({ className, ...props }: WandInputProps) {
  return (
    <AppicaInput
      {...props}
      className={classNames("wand-ui-input", staticClassName(className))}
    />
  );
}
