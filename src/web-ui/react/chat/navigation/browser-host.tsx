import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WandUiProvider } from "../../theme.js";
import { TurnNavPanel, type TurnNavPanelProps } from "./TurnNavPanel.js";

const islands = new Map<HTMLElement, { root: Root; signature: string }>();
export function paintTurnNavigation(output: HTMLElement, props: TurnNavPanelProps | null): void {
  for (const [host, island] of islands) if (!host.isConnected || host.parentElement === output && !props) {
    island.root.unmount(); islands.delete(host); host.remove();
  }
  if (!props) return;
  let host = output.querySelector<HTMLElement>(":scope > .chat-turn-navigation-host");
  if (!host) { host = document.createElement("div"); host.className = "chat-turn-navigation-host"; output.appendChild(host); }
  const signature = JSON.stringify([props.scope, props.entries, props.range]);
  let island = islands.get(host);
  if (island?.signature === signature) return;
  if (!island) { island = { root: createRoot(host), signature }; islands.set(host, island); }
  island.signature = signature;
  island.root.render(<WandUiProvider><TurnNavPanel key={props.scope} {...props}/></WandUiProvider>);
}
