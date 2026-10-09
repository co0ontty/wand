import * as React from "react";
import { createPortal, flushSync } from "react-dom";
import { Layout } from "antd";
import { createRoot, type Root } from "react-dom/client";
import { WandUiMeasurementProvider } from "../theme";
import { ShellTopbarChrome } from "./shell-topbar";
import type { UiSnapshotData } from "./ui-store";
import { FirstStandaloneSessionChrome, FirstWorkspaceWindowChrome } from "../workspaces/workspace-tab-chrome";
import type { WorkspaceSessionSummary } from "../workspaces/types";
import { TerminalShortcutsChrome } from "../composer-rail/terminal-shortcuts";
import { ComposerRailSubmitChrome } from "../composer-rail/host";

let probeSequence = 0;

/** Reuse production chrome without live store, clock, menu or business effects. */
function measureCreationChrome(chrome: React.ReactNode, width: number, selector: string): number {
  const host = document.createElement("div");
  host.dataset.terminalCreationMeasure = "true";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  Object.assign(host.style, {
    position: "fixed", left: "-10000px", top: "0", width: `${width}px`,
    visibility: "hidden", pointerEvents: "none", contain: "layout style",
  });
  document.body.appendChild(host);
  let root: Root | undefined;
  try {
    root = createRoot(host, { identifierPrefix: `wand-terminal-measure-${++probeSequence}-` });
    flushSync(() => root!.render(<WandUiMeasurementProvider><Layout>{chrome}</Layout></WandUiMeasurementProvider>));
    return host.querySelector(selector)?.getBoundingClientRect().height ?? 0;
  } finally {
    try { flushSync(() => root?.unmount()); } finally { host.remove(); }
  }
}

export function measureTerminalCreationTopbar(snapshot: UiSnapshotData, width: number): number {
  return measureCreationChrome(<ShellTopbarChrome snapshot={snapshot} measurement/>, width, ".main-header-row");
}

export function measureTerminalCreationWorkspaceTabbar(props: {
  mobile: boolean; taskName: string; session: WorkspaceSessionSummary;
}, width: number): number {
  return measureCreationChrome(<FirstWorkspaceWindowChrome {...props}/>, width, ".workspace-tab-bar");
}

export function measureTerminalCreationStandaloneTabbar(props: {
  mobile: boolean; session: WorkspaceSessionSummary;
}, width: number): number {
  return measureCreationChrome(<FirstStandaloneSessionChrome {...props}/>, width, '[data-session-tabs="standalone"]');
}

/** Project the running PTY presentation without changing the composer owner or draft. */
export function prepareTerminalCreationComposer(panel: HTMLElement): () => void {
  const slots: HTMLElement[] = [];
  const undo: Array<() => void> = [];
  const style = (node: HTMLElement, property: string, value: string) => {
    const previous = node.style.getPropertyValue(property), priority = node.style.getPropertyPriority(property);
    undo.push(() => previous ? node.style.setProperty(property, previous, priority) : node.style.removeProperty(property));
    node.style.setProperty(property, value, "important");
  };
  let root: Root | undefined;
  const restore = () => {
    try { flushSync(() => root?.unmount()); } finally {
      for (const node of slots) node.remove();
      for (const action of undo.reverse()) action();
    }
  };
  try {
    // Canonical session selection clears the old todo and structured status.
    // Project that empty future row without changing its nodes or timer owner.
    const topRow = panel.querySelector<HTMLElement>(".composer-top-row");
    if (topRow) style(topRow, "display", "none");
    const composer = panel.querySelector<HTMLElement>(".input-composer");
    if (composer) {
      const className = composer.className;
      undo.push(() => { composer.className = className; });
      composer.classList.add("is-terminal-interactive");
    }
    const input = panel.querySelector<HTMLElement>(".input-textarea");
    if (input) {
      // The canonical empty/passthrough resize uses the responsive CSS minimum.
      // Only the presentation changes here; the old value and caret stay owned.
      style(input, "min-height", "");
      const minimum = parseFloat(getComputedStyle(input).minHeight);
      style(input, "height", `${Number.isFinite(minimum) ? minimum : 40}px`);
    }
    const portals: React.ReactPortal[] = [];
    const shortcuts = panel.querySelector<HTMLElement>(".terminal-shortcuts");
    if (shortcuts?.hidden && !document.documentElement.classList.contains("is-wand-native-input")) {
      const slot = document.createElement("div"); slot.className = "terminal-shortcuts";
      slots.push(slot); shortcuts.before(slot);
      portals.push(createPortal(<TerminalShortcutsChrome disabled={false}/>, slot));
    }
    const rail = panel.querySelector<HTMLElement>("[data-composer-rail-host]");
    if (rail && !document.documentElement.classList.contains("is-wand-embed-terminal") && !rail.querySelector(".wand-composer-rail-submit")) {
      const slot = document.createElement("span"); slot.style.display = "contents";
      slots.push(slot); rail.appendChild(slot);
      portals.push(createPortal(<ComposerRailSubmitChrome/>, slot));
    }
    if (portals.length) {
      const host = document.createElement("div"); slots.push(host);
      host.dataset.terminalCreationMeasure = "true"; host.inert = true;
      document.body.appendChild(host);
      root = createRoot(host, { identifierPrefix: `wand-terminal-measure-${++probeSequence}-` });
      flushSync(() => root!.render(<WandUiMeasurementProvider>{portals}</WandUiMeasurementProvider>));
    }
    return restore;
  } catch (error) { restore(); throw error; }
}
