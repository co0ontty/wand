import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ComposerSender, type ResizeInput, type SenderProjection } from "../react/composer-sender/host.js";
import { WandUiProvider } from "../react/theme";
import { installStyleSheet } from "../react/styles";
import { composer, state } from "./state.js";
import { mountComposerSurfaces } from "./composer-surface-adapter";
import { ComposerIdentity, ComposerUsage } from "../react/composer-sender/identity.js";
import { computeRunningSignal } from "../session-activity.js";
import { computeRunningPhase } from "../running-activity.js";
import { composerAvatarActivity } from "../composer-avatar-activity.js";
import { latestChatUsage } from "../chat-message-meta.js";
import { renderStructuredStatusBar } from "./utils.js";
interface Mount { root: Root; input: HTMLTextAreaElement; chrome: HTMLElement; }
const roots = new Map<HTMLElement, Mount>();
const avatarRoots = new Map<HTMLElement, Root>();
const projection: SenderProjection = {
  subscribe: composer.subscribe.bind(composer),
  revision: () => composer.read(state.selectedId).revision,
  text: () => composer.read(state.selectedId).text,
  isComposing: () => state.composerComposing,
};

export function syncComposerCompanion(): void {
  for (const [host, root] of avatarRoots) if (!host.isConnected) { root.unmount(); avatarRoots.delete(host); }
  const avatarHost = document.querySelector<HTMLElement>("[data-composer-avatar-host]");
  const session = state.sessions.find(session => session.id === state.selectedId);
  const activity = session ? { ...session, ptyRunning: computeRunningSignal(session).ptyRunning,
    turnStartedAt: session.ptyTurnStartedAt, lastActivityAt: session.ptyLastActivityAt } : undefined;
  if (avatarHost) {
    const root = avatarRoots.get(avatarHost) ?? createRoot(avatarHost);
    avatarRoots.set(avatarHost, root);
    // Set the text lane before Sender measures the restored draft's height.
    flushSync(() => root.render(<>
      {session?.employeeId ? <ComposerIdentity fileActivity={composerAvatarActivity(activity, session.messages)} thinking={computeRunningPhase(activity) === "executing"} employee={{
        id: session.employeeId, name: session.employeeName || "员工", avatar: session.employeeAvatar,
      }}/> : null}
      <ComposerUsage employeeName={session?.employeeId ? session.employeeName || "员工" : undefined} usage={latestChatUsage(session?.messages ?? [])} activity={activity} legacyStatus={session?.sessionKind === "structured"}/>
    </>));
    renderStructuredStatusBar(null, session);
  }
}

export function mountComposerSender(resize: ResizeInput): void {
  mountComposerSurfaces();
  syncComposerCompanion();
  const session = state.sessions.find(session => session.id === state.selectedId);
  installStyleSheet("wand-sender-owned-input", `[data-composer-sender] .ant-sender-input { width:100%; }`);
  for (const [target, mount] of roots) if (!target.isConnected) { mount.root.unmount(); roots.delete(target); }
  const target = document.querySelector<HTMLElement>("[data-composer-sender]");
  if (!target) return;
  const structured = session?.sessionKind === "structured";
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
