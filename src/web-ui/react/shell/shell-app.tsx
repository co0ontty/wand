import * as React from "react";

import { ShellMainContent, type ShellMainContentRefs } from "./shell-main-content";
import { ShellSidebar } from "./shell-sidebar";
import { UiStoreProvider, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData, UiStore } from "./ui-store";

export type ShellLayoutState = Pick<
  UiSnapshotData["layout"],
  "sessionsDrawerOpen" | "sidebarAnchored" | "sidebarPinned" | "sidebarCollapsed"
>;

export interface ShellAppFrameProps {
  readonly legacyRefs?: Readonly<ShellMainContentRefs>;
}

export interface ShellAppProps extends ShellAppFrameProps {
  readonly store: UiStore;
}

/** Projects the legacy layout classes without reading browser state or DOM. */
export function getShellLayoutClassName(layout: Readonly<ShellLayoutState>): string {
  const classes = ["main-layout"];
  if (layout.sessionsDrawerOpen) classes.push("sidebar-open");
  if (layout.sidebarAnchored) classes.push("sidebar-pinned");
  if (layout.sidebarPinned && layout.sidebarCollapsed) classes.push("sidebar-collapsed");
  return classes.join(" ");
}

/** Provider-independent frame kept public for isolated rendering and tests. */
export function ShellAppFrame({ legacyRefs }: ShellAppFrameProps = {}) {
  const snapshot = useUiStoreSnapshot();
  return (
    <div className="app-container">
      <div className={getShellLayoutClassName(snapshot.layout)}>
        <ShellSidebar/>
        <ShellMainContent legacyRefs={legacyRefs}/>
      </div>
    </div>
  );
}

/** Stable shell composition boundary used by the browser migration adapter. */
export function ShellApp({ store, legacyRefs }: ShellAppProps) {
  return (
    <UiStoreProvider store={store}>
      <ShellAppFrame legacyRefs={legacyRefs}/>
    </UiStoreProvider>
  );
}
