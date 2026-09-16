import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import * as React from "react";
import { classNames } from "./class-names";
import { WandIcon, type WandIconName } from "./icons";

/**
 * 浮层内的菜单行 / 分隔线 / 分组标题。
 *
 * 全站只保留这一份实现：图标 + 主标签 + 右侧提示的三段式布局，
 * 行高、圆角、内边距、字号都取 `--menu-*` token，hover / focus / active
 * / danger / disabled 状态一次定义。业务模块不要再写自己的
 * `.xxx-menu-item`——那正是菜单看起来「有的精致有的廉价」的来源。
 */

export interface WandMenuItemProps extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
  label: ReactNode;
  icon?: WandIconName;
  /** 右侧次要信息（计数、状态文字）。 */
  hint?: ReactNode;
  /** 右侧等宽快捷键提示，例如 "⌘K"。 */
  shortcut?: string;
  tone?: "default" | "danger";
  selected?: boolean;
}

export const WandMenuItem = forwardRef<HTMLButtonElement, WandMenuItemProps>(function WandMenuItem(
  { label, icon, hint, shortcut, tone = "default", selected, className, type, ...props },
  ref,
) {
  return (
    <button
      {...props}
      onClick={props.onClick}
      ref={ref}
      type={type ?? "button"}
      role={props.role ?? "menuitem"}
      aria-checked={selected === undefined ? props["aria-checked"] : selected}
      className={classNames(
        "wand-ui-menu-item",
        tone === "danger" && "wand-ui-menu-item-danger",
        className,
      )}
    >
      {icon ? <WandIcon className="wand-ui-menu-item-icon" name={icon} size={15}/> : null}
      <span className="wand-ui-menu-item-label">{label}</span>
      {hint != null ? <span className="wand-ui-menu-item-hint">{hint}</span> : null}
      {shortcut ? <span className="wand-ui-menu-item-hint">{shortcut}</span> : null}
    </button>
  );
});

export function WandMenuSeparator({ className }: { className?: string }) {
  return <div className={classNames("wand-ui-menu-separator", className)} role="separator"/>;
}

export function WandMenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={classNames("wand-ui-menu-label", className)}>{children}</div>;
}

export function WandMenu({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={classNames("wand-ui-menu", className)}>{children}</div>;
}
