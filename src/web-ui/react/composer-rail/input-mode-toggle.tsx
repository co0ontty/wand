import * as React from "react";
import { WandButton, WandIcon } from "../ui/index.js";
import { ConversationMorphIcon } from "../conversations/controls.js";

import type { PtyInputMode } from "../../pty-input-state.js";
export type { PtyInputMode } from "../../pty-input-state.js";

/** The same button and both label/icon layers remain mounted in either view. */
export const PtyInputModeToggle = React.forwardRef<HTMLButtonElement, {
  mode: PtyInputMode; hasDraft?: boolean; disabled?: boolean; onToggle(): void;
}>(({ mode, hasDraft, disabled, onToggle }, ref) => {
  const keyboard = mode === "keyboard";
  const label = keyboard ? "切换到快捷键" : "切换到键盘输入" + (hasDraft ? " · 有草稿" : "");
  return <WandButton ref={ref} kind="soft" className="pty-input-mode-toggle" data-mode={mode}
    aria-label={label} title={label} aria-controls="input-box terminal-shortcuts" disabled={disabled}
    onPointerDown={event => event.preventDefault()} onClick={onToggle}>
    <ConversationMorphIcon from="keyboard" to="keycaps" active={keyboard}/>
    <span className="pty-input-mode-label" aria-hidden="true">
      <span data-active={!keyboard}>键盘{hasDraft ? <i className="pty-draft-dot"/> : null}</span><span data-active={keyboard}>快捷键</span>
    </span>
  </WandButton>;
});

/** Collapsed: a slim "按键" entry. Expanded: a chevron that tucks the dock away again. */
export function PtyDockToggle({ collapsed, hasDraft, disabled, onToggle }: {
  collapsed: boolean; hasDraft?: boolean; disabled?: boolean; onToggle(): void;
}): React.ReactElement {
  const label = collapsed ? "展开终端按键" + (hasDraft ? " · 有草稿" : "") : "收起终端按键";
  return <WandButton kind="soft" className="pty-dock-toggle" data-collapsed={collapsed} aria-label={label} title={label}
    aria-expanded={!collapsed} aria-controls="terminal-shortcuts" disabled={disabled}
    onPointerDown={event => event.preventDefault()} onClick={onToggle}>
    {collapsed ? <><WandIcon name="keyboard" size={16}/><span>按键{hasDraft ? <i className="pty-draft-dot"/> : null}</span><WandIcon name="chevronUp" size={14}/></>
      : <WandIcon name="chevronDown" size={16}/>}
  </WandButton>;
}
