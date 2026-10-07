import * as React from "react";
import { WandIcon, WandButton, type WandIconName } from "../ui";

/** The same action row is used by the main composer and the group chat attachment menu. */
export function ComposerPopoverAction({ id, icon, label, onClick }: {
  id?: string;
  icon: WandIconName;
  label: string;
  onClick(event: React.MouseEvent<HTMLButtonElement>): void;
}): React.ReactElement {
  return <WandButton kind="ghost" id={id} type="button" onClick={onClick}>
    <WandIcon name={icon} size={14} strokeWidth={1.8} className="plus-popover-icon" />
    <span className="plus-popover-label">{label}</span>
  </WandButton>;
}
