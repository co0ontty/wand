import * as React from "react";
import { WandIcon } from "../ui/index.js";

/**
 * 分组一级行：左边「头像 + 名字 + 计数」，右边「快捷新增 + 折叠箭头」。
 * 一级行自己承载头像，二级会话行不再重复身份（与安卓首页同一口径）。
 *
 * 结构上是 div 里套两个 button：一级行本身可点（折叠），右侧的快捷新增是独立动作，
 * 不能把按钮嵌进按钮。
 */
export function ImSidebarGroup({
  label,
  count,
  hasAttention = false,
  avatarNode,
  action,
  expanded = true,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  hasAttention?: boolean;
  avatarNode?: React.ReactNode;
  /** 一级行右侧的快捷动作（例如「+ 新建对话」）。 */
  action?: React.ReactNode;
  expanded?: boolean;
  onToggle?(): void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={`im-sidebar-group${expanded ? " is-expanded" : ""}`}>
      <div className="im-sidebar-group-header">
        <button
          type="button"
          className="im-sidebar-group-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {avatarNode ? <span className="im-sidebar-group-avatar" aria-hidden="true">{avatarNode}</span> : null}
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
        {action ? <span className="im-sidebar-group-action">{action}</span> : null}
      </div>

      <div className={`im-sidebar-group-content${!expanded ? " is-collapsed" : ""}`}>
        <div className="im-sidebar-group-inner">
          {children}
        </div>
      </div>
    </div>
  );
}
