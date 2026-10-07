import { Input, type InputRef } from "antd";
import * as React from "react";
import { classNames } from "./class-names";
import { WandUiBoundary } from "../theme";

export interface WandInputProps extends Omit<React.ComponentPropsWithRef<"input">, "size"> {
  size?: "sm" | "md" | "lg";
  inputSize?: "sm" | "md" | "lg";
  variant?: "outline" | "filled";
  inputProps?: React.ComponentPropsWithRef<"input">;
  startSlot?: React.ReactNode;
  endSlot?: React.ReactNode;
  clearable?: boolean;
  onClear?(): void;
}

/** Expose the real input node, keeping caret/focus ownership in the consumer. */
export function WandInput({ className, size = "md", inputSize = size, variant = "outline", inputProps, startSlot, endSlot, clearable, onClear, ref, ...props }: WandInputProps) {
  const assignRef = React.useCallback((instance: InputRef | null) => {
    const node = instance?.input ?? null;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }, [ref]);
  const invalid = inputProps?.["aria-invalid"] ?? props["aria-invalid"];
  return <WandUiBoundary><Input {...props} {...inputProps} status={invalid === true || invalid === "true" ? "error" : undefined} variant={variant === "outline" ? "outlined" : "filled"} ref={assignRef} prefix={startSlot} suffix={endSlot}
    allowClear={clearable} onClear={onClear} size={inputSize === "sm" ? "small" : inputSize === "lg" ? "large" : "middle"}
    className={classNames("wand-ui-input", className)}/></WandUiBoundary>;
}
