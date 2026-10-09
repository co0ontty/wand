import * as React from "react";
import { Card, Flex, Typography } from "antd";

import { WandIcon, WandIconButton } from "../ui";
import { classNames } from "../ui/class-names";

export interface SidebarPeekProps {
  readonly open: boolean;
  readonly title: string;
  readonly top?: number;
  readonly surfaceRef: React.RefObject<HTMLDivElement | null>;
  onExpand(): void;
  onKeyDown?(event: React.KeyboardEvent<HTMLElement>): void;
  onPointerEnter(event: React.PointerEvent<HTMLElement>): void;
  onPointerLeave(event: React.PointerEvent<HTMLElement>): void;
  onFocusCapture(event: React.FocusEvent<HTMLElement>): void;
  onBlurCapture(event: React.FocusEvent<HTMLElement>): void;
  children: React.ReactNode;
}

/**
 * 折叠窄栏的目录预览：悬停某个目录图标时，仅弹出该目录的
 * 「任务 → 终端」层级，点击即切换会话，离开后自动收回。
 *
 * 面板挂在 `.sidebar` 内部（不 portal），这样它继承侧栏的调色板与
 * `#app[data-react-shell="enabled"]` 下的任务树样式，和完整侧栏长得一致。
 * 关闭态用 `visibility: hidden` + `inert` 隐藏，不拦截指针也不进入 Tab 序。
 */
export function SidebarPeek({
  open,
  title,
  top = 8,
  surfaceRef,
  onExpand,
  onKeyDown,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
  children,
}: SidebarPeekProps) {
  return (
    <Card size="small"
      id="sidebar-peek"
      ref={surfaceRef}
      className={classNames("sidebar-peek", open && "open")}
      style={{ position: "absolute", top, left: "100%", marginLeft: 8, width: "min(320px, calc(100vw - 144px))", maxHeight: `calc(100dvh - ${top + 12}px)`, zIndex: 20020, visibility: open ? "visible" : "hidden", pointerEvents: open ? undefined : "none", overflow: "hidden" }}
      styles={{ body: { display: "flex", flexDirection: "column", minHeight: 0, maxHeight: `calc(100dvh - ${top + 40}px)` } }}
      data-open={open || undefined}
      aria-label={title}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Flex align="center" justify="space-between" gap="small" className="sidebar-peek-header" style={{ flexShrink: 0 }}>
        <Typography.Text strong ellipsis className="sidebar-peek-title" title={title}>{title}</Typography.Text>
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
      </Flex>
      <div className="sidebar-peek-body" style={{ minHeight: 0, overflow: "auto" }}>{children}</div>
    </Card>
  );
}
