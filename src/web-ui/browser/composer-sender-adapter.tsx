import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ComposerSender, type ResizeInput, type SenderProjection } from "../react/composer-sender/host.js";
import { WandUiProvider } from "../react/theme";
import { installStyleSheet } from "../react/styles";
import { composer, state } from "./state.js";
import { mountComposerSurfaces } from "./composer-surface-adapter";
interface Mount { root: Root; input: HTMLTextAreaElement; chrome: HTMLElement; }
const roots = new Map<HTMLElement, Mount>();
const projection: SenderProjection = {
  subscribe: composer.subscribe.bind(composer),
  revision: () => composer.read(state.selectedId).revision,
  text: () => composer.read(state.selectedId).text,
  isComposing: () => state.composerComposing,
};

export function mountComposerSender(resize: ResizeInput): void {
  mountComposerSurfaces();
  installStyleSheet("wand-sender-owned-input", `[data-composer-sender] .ant-sender-input { width:100%; }`);
  for (const [target, mount] of roots) if (!target.isConnected) { mount.root.unmount(); roots.delete(target); }
  const target = document.querySelector<HTMLElement>("[data-composer-sender]");
  if (!target) return;
  const structured = state.sessions.find(session => session.id === state.selectedId)?.sessionKind === "structured";
  const previous = roots.get(target);
  if (!structured) {
    if (previous) {
      const active = document.activeElement === previous.input;
      const parent = target as HTMLElement & { moveBefore?(node: Node, child: Node | null): void };
      if (parent.moveBefore) parent.moveBefore(previous.input, null);
      else { target.appendChild(previous.input); if (active) previous.input.focus({ preventScroll: true }); }
      previous.root.unmount(); previous.chrome.remove(); roots.delete(target);
      previous.input.className = "input-textarea";
    }
    return;
  }
  if (previous) return;
  const input = target.querySelector<HTMLTextAreaElement>("#input-box");
  if (!input) return;
  const chrome = document.createElement("div"); target.appendChild(chrome);
  const root = createRoot(chrome); roots.set(target, { root, chrome, input });
  flushSync(() => root.render(<WandUiProvider><ComposerSender input={input} resize={resize} projection={projection}/></WandUiProvider>));
}
