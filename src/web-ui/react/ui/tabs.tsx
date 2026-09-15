import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@appica/ui-react/tabs";
import type { ReactNode } from "react";
import { classNames } from "./class-names";

interface WandTabItem {
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
  /** Drives Appica's orientation-aware trigger/list styling. */
  orientation?: "horizontal" | "vertical";
  onValueChange?(value: string): void;
}

export function WandTabs({
  tabs,
  value,
  defaultValue,
  ariaLabel,
  className,
  orientation = "horizontal",
  onValueChange,
}: WandTabsProps) {
  const initialValue = defaultValue ?? tabs[0]?.value;
  return (
    <Tabs
      className={className}
      orientation={orientation}
      value={value}
      defaultValue={initialValue}
      onValueChange={(next) => onValueChange?.(String(next))}
    >
      <TabsList className="wand-ui-tabs-list" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            className="wand-ui-tabs-trigger"
            value={tab.value}
            disabled={tab.disabled}
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.value}
          className={classNames("wand-ui-tabs-content")}
          value={tab.value}
        >
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
