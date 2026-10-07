import { Tabs } from "antd";
import type { ReactNode } from "react";
import { WandUiBoundary } from "../theme";
interface WandTabItem { value: string; label: ReactNode; content: ReactNode; disabled?: boolean; }
export interface WandTabsProps {
  tabs: ReadonlyArray<WandTabItem>;
  value?: string;
  defaultValue?: string;
  ariaLabel: string;
  className?: string;
  orientation?: "horizontal" | "vertical";
  onValueChange?(value: string): void;
}
export function WandTabs({ tabs, value, defaultValue, ariaLabel, className, orientation = "horizontal", onValueChange }: WandTabsProps) {
  return <WandUiBoundary><Tabs className={className} aria-label={ariaLabel}
    activeKey={value} defaultActiveKey={defaultValue ?? tabs[0]?.value} tabPlacement={orientation === "vertical" ? "start" : "top"}
    onChange={onValueChange} items={tabs.map(tab => ({ key: tab.value, label: tab.label, children: tab.content, disabled: tab.disabled }))}/></WandUiBoundary>;
}
