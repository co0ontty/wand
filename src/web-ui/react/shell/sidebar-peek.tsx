import * as React from "react";

import { WandIcon, WandIconButton } from "../ui";
import { classNames } from "../ui/class-names";

export interface SidebarPeekProps {
  readonly open: boolean;
  readonly surfaceRef: React.RefObject<HTMLDivElement | null>;
  onExpand(): void;
  onPointerEnter(event: React.PointerEvent<HTMLElement>): void;
  onPointerLeave(event: React.PointerEvent<HTMLElement>): void;
  onFocusCapture(): void;
  onBlurCapture(event: React.FocusEvent<HTMLElement>): void;
  children: React.ReactNode;
}

/**
 * 折叠窄栏的悬浮目录树：鼠标停在 56px 窄栏上时向右弹出完整
 * 「目录 → 任务 → 终端」层级，点击即切换会话，离开后自动收回。
 *
 * 面板挂在 `.sidebar` 内部（不 portal），这样它继承侧栏的调色板与
 * `#app[data-react-shell="enabled"]` 下的任务树样式，和完整侧栏长得一致。
 * 关闭态用 `visibility: hidden` + `inert` 隐藏，不拦截指针也不进入 Tab 序。
 */
export function SidebarPeek({
  open,
  surfaceRef,
  onExpand,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
  children,
}: SidebarPeekProps) {
  return (
    <div
      id="sidebar-peek"
      ref={surfaceRef}
      className={classNames("sidebar-peek", open && "open")}
      data-open={open || undefined}
      aria-label="任务目录"
      aria-hidden={!open}
      inert={!open}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <div className="sidebar-peek-header">
        <span className="sidebar-peek-title">任务目录</span>
        <WandIconButton
          className="sidebar-peek-expand"
          kind="ghost"
          size="small"
          title="展开成完整侧栏"
          aria-label="展开成完整侧栏"
          onClick={onExpand}
        >
          <WandIcon name="rail" size={15} className="sidebar-rail-icon"/>
        </WandIconButton>
      </div>
      <div className="sidebar-peek-body">{children}</div>
    </div>
  );
}
