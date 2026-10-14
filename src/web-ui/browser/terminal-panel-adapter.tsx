import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { WandUiProvider } from "../react/theme";
import { TerminalShortcutsChrome } from "../react/composer-rail/terminal-shortcuts";

const roots = new Map<HTMLElement, { root: Root; disabled: boolean; onKey: (key: string) => void; owner: string }>();

/** The input owner handles dispatch; Ant owns buttons and their keyboard semantics. */
export function paintTerminalPanel(host: HTMLElement, disabled: boolean, onKey: (key: string) => void, owner = ""): void {
  for (const [node, entry] of roots) {
    if (!node.isConnected) { entry.root.unmount(); roots.delete(node); }
  }
  const previous = roots.get(host);
  if (previous && previous.disabled === disabled && previous.onKey === onKey && previous.owner === owner) return;
  const root = previous?.root ?? createRoot(host);
  roots.set(host, { root, disabled, onKey, owner });
  flushSync(() => root.render(<WandUiProvider>
    <TerminalShortcutsChrome disabled={disabled} onKey={onKey} owner={owner}/>
  </WandUiProvider>));
}
