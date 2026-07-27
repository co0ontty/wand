import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { classNames } from "./class-names";

export interface WandTabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface WandTabsProps {
  tabs: ReadonlyArray<WandTabItem>;
  value?: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
  onValueChange?(value: string): void;
}

export function WandTabs({
  tabs,
  value,
  defaultValue,
  ariaLabel,
  className,
  onValueChange,
}: WandTabsProps) {
  const initialValue = defaultValue ?? tabs[0]?.value;
  return (
    <TabsPrimitive.Root
      className={className}
      value={value}
      defaultValue={initialValue}
      onValueChange={onValueChange}
    >
      <TabsPrimitive.List className="wand-ui-tabs-list" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            className="wand-ui-tabs-trigger"
            value={tab.value}
            disabled={tab.disabled}
          >
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content
          key={tab.value}
          className={classNames("wand-ui-tabs-content")}
          value={tab.value}
        >
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
