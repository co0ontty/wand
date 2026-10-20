import * as React from "react";
import { WandIcon, WandIconButton } from "../ui";

export const QuickTerminalActionContext = React.createContext<{
  open: boolean;
  show(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
  chromeHost: HTMLDivElement;
  setTopbarActive(active: boolean): void;
} | null>(null);

export function QuickTerminalButton() {
  const action = React.useContext(QuickTerminalActionContext);
  if (!action) return null;
  return <WandIconButton ref={action.trigger} aria-label="打开终端" title="打开终端（运行在 Wand / PTY 主机）" aria-expanded={action.open} aria-controls="quick-terminal-panel" data-pressed={action.open || undefined} onClick={action.show}><WandIcon name="terminal" size={18}/></WandIconButton>;
}

/** Reuse the existing session topbar; other page owners retain a fallback action. */
export function QuickTerminalTopbarAction({ visible }: { visible: boolean }) {
  const action = React.useContext(QuickTerminalActionContext);
  const register = action?.setTopbarActive;
  React.useLayoutEffect(() => {
    register?.(visible);
    return () => register?.(false);
  }, [register, visible]);
  return visible ? <QuickTerminalButton/> : null;
}
