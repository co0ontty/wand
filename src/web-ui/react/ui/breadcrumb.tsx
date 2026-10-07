import { WandButton } from "./button";
import { Breadcrumb } from "antd";
import * as React from "react";
import { classNames } from "./class-names";
import { WandUiBoundary } from "../theme";
export interface WandCrumbItem { label: string; onNavigate?(): void; }
export interface WandBreadcrumbProps {
  items: ReadonlyArray<WandCrumbItem>;
  variant?: "title" | "compact";
  className?: string;
  ariaLabel?: string;
}
export function WandBreadcrumb({ items, variant = "compact", className, ariaLabel = "面包屑" }: WandBreadcrumbProps): React.ReactElement {
  return <WandUiBoundary><Breadcrumb className={classNames("wand-crumb", variant === "title" ? "is-title" : "is-compact", className)}
    aria-label={ariaLabel} items={items.map((item, index) => ({ title: index === items.length - 1
      ? variant === "title" ? <h1 aria-current="page">{item.label}</h1> : <strong aria-current="page">{item.label}</strong>
      : <WandButton kind="ghost" size="small" type="button" onClick={item.onNavigate}>{item.label}</WandButton> }))}/></WandUiBoundary>;
}
