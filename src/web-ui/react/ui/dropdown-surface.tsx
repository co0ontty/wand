import { Dropdown, type DropdownProps, type MenuProps } from "antd";
import * as React from "react";

export interface DropdownSurfaceProps {
  trigger: React.ReactElement;
  /** antd Dropdown 把 ref 落在触发器元素上：菜单收起后的焦点归还靠它。 */
  triggerRef?: React.Ref<HTMLElement>;
  open: boolean;
  disabled?: boolean;
  triggers?: DropdownProps["trigger"];
  onOpenChange(open: boolean, info: { source: string }): void;
  getPopupContainer(): HTMLElement;
  placement?: DropdownProps["placement"];
  align?: DropdownProps["align"];
  classNames?: DropdownProps["classNames"];
  styles?: DropdownProps["styles"];
  menu: MenuProps;
  popupRender?(menu: React.ReactNode): React.ReactNode;
  autoFocus?: boolean;
  destroyOnHidden?: boolean;
}

/**
 * antd Dropdown 单独成块：菜单只在用户真的点开时才出现，
 * Dropdown/Menu/rc-menu 的实现不必跟着首屏 runtime 一起下载。
 * 触发器与菜单项由调用方持有，这里只负责弹层本体。
 */
export function DropdownSurface(props: DropdownSurfaceProps): React.ReactElement {
  const { trigger, triggerRef, triggers, ...rest } = props;
  // Ant 的属性名是 trigger；传错会静默退回默认的 hover 触发。
  return <Dropdown ref={triggerRef as React.Ref<never>} trigger={triggers} {...rest}>{trigger}</Dropdown>;
}
