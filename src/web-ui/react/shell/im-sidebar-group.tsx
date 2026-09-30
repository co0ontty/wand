import * as React from "react";
import { WandIcon } from "../ui/index.js";

export function ImSidebarGroup({
  label,
  count,
  hasAttention = false,
  emptyCta,
  expanded = true,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  hasAttention?: boolean;
  emptyCta?: React.ReactNode;
  expanded?: boolean;
  onToggle?(): void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={`im-sidebar-group${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="im-sidebar-group-header"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="im-sidebar-group-title">{label}</span>
        <span className="im-sidebar-group-meta">
          <span className="im-sidebar-group-count">{count}</span>
          {hasAttention ? <span className="im-sidebar-group-attention-dot" /> : null}
        </span>
        <WandIcon
          name="chevron"
          className={`im-sidebar-group-chevron${expanded ? " is-rotated" : ""}`}
        />
      </button>

      <div className={`im-sidebar-group-content${!expanded ? " is-collapsed" : ""}`}>
        <div className="im-sidebar-group-inner">
          {count === 0 && emptyCta ? emptyCta : children}
        </div>
      </div>
    </div>
  );
}
