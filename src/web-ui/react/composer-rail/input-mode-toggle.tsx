import * as React from "react";
import { WandButton } from "../ui/index.js";
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
