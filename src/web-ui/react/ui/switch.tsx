import { Switch } from "@appica/ui-react/switch";
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
  /** Appica scale. `lg` matches the previous 42x24 wand switch geometry. */
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
      <Switch
        id={switchId}
        size={size}
        className="wand-ui-switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={onCheckedChange}
      />
      {label ? <label htmlFor={switchId}>{label}</label> : null}
    </div>
  );
}
