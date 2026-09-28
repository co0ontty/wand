import * as React from "react";
import { classNames } from "./class-names";

export interface WandCrumbItem {
  label: string;
  /** 缺省 = 当前段（不可点）。中间段一律要传，否则退化成纯文本。 */
  onNavigate?(): void;
}

export interface WandBreadcrumbProps {
  items: ReadonlyArray<WandCrumbItem>;
  /** title：末段是页面 h1；compact：整行是区块级小标题。 */
  variant?: "title" | "compact";
  className?: string;
  ariaLabel?: string;
}

/** 单层页面头部的面包屑：`任务看板 › TASK-108`，替代重复的二级标题。 */
export function WandBreadcrumb({
  items,
  variant = "compact",
  className,
  ariaLabel = "面包屑",
}: WandBreadcrumbProps): React.ReactElement {
  const lastIndex = items.length - 1;
  return <nav className={classNames("wand-crumb", variant === "title" ? "is-title" : "is-compact", className)} aria-label={ariaLabel}>
    <ol>
      {items.map((item, index) => {
        const current = index === lastIndex;
        return <li key={`${index}:${item.label}`}>
          {current
            ? variant === "title"
              ? <h1 aria-current="page">{item.label}</h1>
              : <strong aria-current="page">{item.label}</strong>
            : <button type="button" onClick={item.onNavigate}>{item.label}</button>}
          {!current && <span className="wand-crumb-sep" aria-hidden="true">›</span>}
        </li>;
      })}
    </ol>
  </nav>;
}
