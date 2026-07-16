import * as SwitchPrimitive from "@radix-ui/react-switch";
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
}

export function WandSwitch({
  checked,
  onCheckedChange,
  ariaLabel,
  label,
  disabled,
  className,
  id,
}: WandSwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <div className={classNames("wand-ui-switch-row", className)}>
      <SwitchPrimitive.Root
        id={switchId}
        className="wand-ui-switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onCheckedChange={onCheckedChange}
      >
        <SwitchPrimitive.Thumb className="wand-ui-switch-thumb" />
      </SwitchPrimitive.Root>
      {label ? <label htmlFor={switchId}>{label}</label> : null}
    </div>
  );
}
