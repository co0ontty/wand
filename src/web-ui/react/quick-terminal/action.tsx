import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon } from "../ui/icons";
import { WandIconButton } from "../ui/button";
import { WandIconFamily } from "../ui/icons";

export const QuickTerminalActionContext = React.createContext<{
  open: boolean;
  show(): void;
  trigger: React.RefObject<HTMLButtonElement | null>;
  chromeHost: HTMLDivElement;
  registerChrome(owner: string): () => void;
} | null>(null);

/** The visible page owns the entire row, not an action button's mount effect.
 * The portal sits outside Splitter so docking never moves the row or remounts content.
 * Owner leases also make route handoff/StrictMode cleanup safe. */
export function QuickTerminalChrome({ children }: { children: React.ReactNode }) {
  const context = React.useContext(QuickTerminalActionContext);
  const owner = React.useId();
  const register = context?.registerChrome;
  React.useLayoutEffect(() => register?.(owner), [register, owner]);
  const chrome = <WandIconFamily value="lucide"><div className="wand-workbar-host">{children}</div></WandIconFamily>;
  return context ? createPortal(chrome, context.chromeHost) : chrome;
}

export function QuickTerminalButton() {
  const action = React.useContext(QuickTerminalActionContext);
  if (!action) return null;
  return <WandIconButton ref={action.trigger} aria-label="打开终端" title="打开终端（运行在 Wand / PTY 主机）" aria-expanded={action.open} aria-controls="quick-terminal-panel" data-pressed={action.open || undefined} onClick={action.show}><WandIcon name="terminal" size={18}/></WandIconButton>;
}

/** Compatibility presentation for the standalone title bar and its static probe. */
export function QuickTerminalTopbarAction({ visible }: { visible: boolean }) {
  return visible ? <QuickTerminalButton/> : null;
}
