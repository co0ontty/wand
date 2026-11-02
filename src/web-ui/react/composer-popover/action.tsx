import * as React from "react";
import { WandIcon, type WandIconName } from "../ui/icons";
import { WandButton } from "../ui/button";

/** The same action row is used by the main composer and the group chat attachment menu. */
export function ComposerPopoverAction({ id, icon, label, title, disabled, busy, onClick }: {
  id?: string;
  icon: WandIconName;
  label: string;
  title?: string;
  disabled?: boolean;
  /** 请求进行中：原位显示进度，不换节点、不位移。 */
  busy?: boolean;
  onClick(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  return <WandButton kind="ghost" id={id} type="button" title={title} disabled={disabled || busy}
    aria-busy={busy ? "true" : undefined} onClick={onClick}>
    <WandIcon name={icon} size={14} strokeWidth={1.8} className="plus-popover-icon" />
    <span className="plus-popover-label">{label}</span>
    {busy ? <span className="plus-popover-toggle-state">…</span> : null}
  </WandButton>;
}
