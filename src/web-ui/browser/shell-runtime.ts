import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  isReactShellEnabled,
  LegacyHost,
  ShellApp,
  type LegacyUiCommands,
  type ShellMainContentRefs,
  type UiStore,
} from "../react";
import { createBrowserUiStoreBridge } from "./ui-store-bridge";

export type BrowserShellRenderResult = "disabled" | "mounted" | "updated";

interface BrowserShellRuntime {
  readonly app: HTMLElement;
  readonly root: Root;
  readonly store: UiStore;
  readonly hosts: readonly LegacyHost<HTMLElement>[];
}

let commands: LegacyUiCommands | null = null;
let runtime: BrowserShellRuntime | null = null;

export function configureBrowserShellCommands(nextCommands: LegacyUiCommands): void {
  if (runtime) throw new Error("Cannot replace browser shell commands after mount");
  commands = nextCommands;
}

export function isBrowserReactShellMounted(): boolean {
  return runtime !== null;
}

function moveChildren(source: Element, target: HTMLElement): void {
  while (source.firstChild) target.appendChild(source.firstChild);
}

function createLegacyRefs(markup: string): {
  refs: ShellMainContentRefs;
  hosts: readonly LegacyHost<HTMLElement>[];
} {
  const template = document.createElement("template");
  template.innerHTML = markup;

  const slots: Array<{
    name: string;
    selector: string;
    key: keyof ShellMainContentRefs;
  }> = [
    { name: "BrowserTerminalSlot", selector: "#output", key: "terminal" },
    { name: "BrowserChatSlot", selector: "#chat-output", key: "chat" },
    { name: "BrowserComposerSlot", selector: ".input-panel", key: "composer" },
    { name: "BrowserFileExplorerSlot", selector: "#file-explorer", key: "fileExplorer" },
    { name: "BrowserCrossSessionQueueSlot", selector: "#cross-session-queue-host", key: "crossSessionQueue" },
  ];
  const refs: Partial<Record<keyof ShellMainContentRefs, React.RefCallback<HTMLDivElement>>> = {};
  const hosts = slots.map(({ name, selector, key }) => {
    const source = template.content.querySelector(selector);
    if (!source) throw new Error(`${name} seed is missing ${selector}`);
    const host = new LegacyHost<HTMLElement>(name, {
      mount(target) {
        moveChildren(source, target);
      },
    });
    refs[key] = (node) => {
      if (node) {
        host.mount(node);
      } else {
        host.unmount();
      }
    };
    return host;
  });

  return { refs: refs as ShellMainContentRefs, hosts };
}

/**
 * Mounts once into authenticated #app. Later calls publish snapshots only;
 * React reconciles around the same four childless legacy roots.
 */
export function renderBrowserReactShell(
  app: HTMLElement,
  createLegacyMarkup: () => string,
): BrowserShellRenderResult {
  if (!isReactShellEnabled()) {
    unmountBrowserReactShell();
    return "disabled";
  }
  if (!commands) throw new Error("Browser shell commands were not configured");

  if (runtime) {
    if (runtime.app !== app) throw new Error("React shell cannot move to a different #app root");
    flushSync(() => runtime?.store.publish({ sync: true, reason: "legacy:render" }));
    return "updated";
  }

  const legacy = createLegacyRefs(createLegacyMarkup());
  const store = createBrowserUiStoreBridge(commands, { batchMs: 0 });
  app.replaceChildren();
  app.dataset.reactShell = "enabled";
  const root = createRoot(app);
  runtime = { app, root, store, hosts: legacy.hosts };
  try {
    flushSync(() => root.render(React.createElement(ShellApp, { store, legacyRefs: legacy.refs })));
  } catch (error) {
    runtime = null;
    store.dispose();
    for (const host of legacy.hosts) host.dispose();
    delete app.dataset.reactShell;
    throw error;
  }
  return "mounted";
}

export function publishBrowserReactShell(reason: string, sync = false): void {
  if (!runtime) return;
  if (sync) {
    flushSync(() => runtime?.store.publish({ sync: true, reason }));
    return;
  }
  runtime.store.publish({ reason });
}

export function unmountBrowserReactShell(): void {
  const active = runtime;
  if (!active) return;
  runtime = null;
  flushSync(() => active.root.unmount());
  active.store.dispose();
  for (const host of active.hosts) host.dispose();
  delete active.app.dataset.reactShell;
}
