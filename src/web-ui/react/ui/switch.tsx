import { Switch } from "antd";
import { WandUiBoundary } from "../theme";
import * as React from "react";
import { useId } from "react";
import { classNames } from "./class-names";

export interface WandSwitchProps {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  ariaLabel: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** Retained Wand scale; sm maps to the library small size, md/lg to default. */
  size?: "sm" | "md" | "lg";
}

export function WandSwitch({
  checked,
  onCheckedChange,
  ariaLabel,
  label,
  disabled,
  className,
  id,
  size = "lg",
}: WandSwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <div className={classNames("wand-ui-switch-row", className)}>
      <WandUiBoundary><Switch
        id={switchId}
        size={size === "sm" ? "small" : "default"}
        className="wand-ui-switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={onCheckedChange}
      /></WandUiBoundary>
      {label ? <label htmlFor={switchId}>{label}</label> : null}
    </div>
  );
}
