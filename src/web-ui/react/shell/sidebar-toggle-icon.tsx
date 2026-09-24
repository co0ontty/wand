// 显式 import React：本仓库的测试（node --test + tsx/esbuild）不读 tsconfig 的
// `jsx` 字段，JSX 会按 classic 运行时编译成 React.createElement，纯 JSX 组件
// （不 import React 的那种）会在 SSR 测试里 ReferenceError。
import * as React from "react";
import type { ReactElement } from "react";
import { WandIcon } from "../ui";

/** Rail icon while the drawer is closed; it turns into a close icon when open. */
export function SidebarToggleIcon({
  open,
  size = 18,
}: {
  open: boolean;
  size?: number;
}): ReactElement {
  return (
    <span className="sidebar-toggle-morph" data-open={open ? "true" : "false"} aria-hidden="true">
      <WandIcon name="rail" size={size} className="sidebar-toggle-morph-rail"/>
      <WandIcon name="close" size={size} className="sidebar-toggle-morph-close"/>
    </span>
  );
}
