import * as SelectPrimitive from "@radix-ui/react-select";
import * as React from "react";
import { classNames } from "./class-names";
import { WandIcon } from "./icons";
import { usePortalContainer } from "./portal-context";

export interface WandSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface WandSelectProps {
  value?: string;
  defaultValue?: string;
  options: ReadonlyArray<WandSelectOption>;
  placeholder?: string;
  displayValue?: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  itemClassName?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
  onValueChange?(value: string): void;
  onOpenChange?(open: boolean): void;
}

export function WandSelect({
  value,
  defaultValue,
  options,
  placeholder = "请选择",
  displayValue,
  ariaLabel,
  disabled,
  className,
  contentClassName,
  itemClassName,
  side,
  align,
  sideOffset = 6,
  collisionPadding = 12,
  onValueChange,
  onOpenChange,
}: WandSelectProps) {
  const portalContainer = usePortalContainer();
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={onValueChange}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        className={classNames("wand-ui-select-trigger", className)}
        aria-label={ariaLabel}
      >
        <SelectPrimitive.Value placeholder={placeholder}>{displayValue}</SelectPrimitive.Value>
        <SelectPrimitive.Icon aria-hidden="true">⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Content
          className={classNames("wand-ui-select-content", contentClassName)}
          position="popper"
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
        >
          <SelectPrimitive.ScrollUpButton className="wand-ui-select-scroll-button">
            ⌃
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="wand-ui-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                className={classNames("wand-ui-select-item", itemClassName)}
                value={option.value}
                disabled={option.disabled}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="wand-ui-select-indicator">
                  <WandIcon name="check" size={12}/>
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="wand-ui-select-scroll-button">
            ⌄
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
