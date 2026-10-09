import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Card } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { installChatComposerStyles } from "../react/chat-composer-styles";

const roots = new Map<HTMLElement, Root>();

/** Adopt, never recreate, the native textarea and all controller-owned hosts. */
function OwnedChildren({ nodes }: { nodes: readonly ChildNode[] }): React.ReactElement {
  const slot = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (slot.current) for (const node of nodes) slot.current.appendChild(node);
  }, [nodes]);
  return <div ref={slot}/>;
}

export function mountComposerSurfaces(): void {
  installChatComposerStyles();
  for (const [host, root] of roots) if (!host.isConnected) { root.unmount(); roots.delete(host); }
  for (const host of document.querySelectorAll<HTMLElement>(".input-composer, #composer-plus-popover")) {
    if (roots.has(host)) continue;
    const nodes = Array.from(host.childNodes);
    const active = document.activeElement as HTMLElement | null;
    const refocus = active && host.contains(active);
    const root = createRoot(host); roots.set(host, root);
    flushSync(() => root.render(<WandUiProvider><Card size="small" className={host.classList.contains("input-composer") ? "composer-surface" : undefined}><OwnedChildren nodes={nodes}/></Card></WandUiProvider>));
    if (refocus) active.focus({ preventScroll: true });
  }
}
