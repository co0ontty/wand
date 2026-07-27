import * as SelectPrimitive from "@radix-ui/react-select";
import { classNames } from "./class-names";
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
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  onValueChange?(value: string): void;
}

export function WandSelect({
  value,
  defaultValue,
  options,
  placeholder = "请选择",
  ariaLabel,
  disabled,
  className,
  onValueChange,
}: WandSelectProps) {
  const portalContainer = usePortalContainer();
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      <SelectPrimitive.Trigger
        className={classNames("wand-ui-select-trigger", className)}
        aria-label={ariaLabel}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon aria-hidden="true">⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Content
          className="wand-ui-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <SelectPrimitive.ScrollUpButton className="wand-ui-select-scroll-button">
            ⌃
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="wand-ui-select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                className="wand-ui-select-item"
                value={option.value}
                disabled={option.disabled}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="wand-ui-select-indicator">
                  ✓
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
