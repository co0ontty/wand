import * as React from "react";
import { EmployeeProfileHost } from "../agents/employee-profile";
import { Layout } from "antd";
import { WandUiProvider } from "../theme";
import { installSidebarStyles } from "./sidebar-styles";

import { ShellMainContent, type ShellMainContentRefs } from "./shell-main-content";
import { ShellSidebar } from "./shell-sidebar";
import { UiStoreProvider, useUiStoreSnapshot } from "./ui-store-react";
import type { UiSnapshotData, UiStore } from "./ui-store";

void React;

export type ShellLayoutState = Pick<
  UiSnapshotData["layout"],
  "sessionsDrawerOpen" | "sidebarAnchored" | "sidebarPinned" | "sidebarCollapsed"
>;

interface ShellAppFrameProps {
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
function ShellAppFrame({ legacyRefs }: ShellAppFrameProps = {}) {
  const snapshot = useUiStoreSnapshot();
  return (
    <Layout className="app-container" style={{ position: "fixed", top: "var(--app-viewport-top, 0px)", left: 0, right: 0, height: "var(--app-viewport-height, 100dvh)", overflow: "hidden", paddingTop: "var(--wand-safe-top, 0px)", paddingBottom: "var(--wand-safe-bottom, 0px)" }}>
      <Layout hasSider className={getShellLayoutClassName(snapshot.layout.sidebarDrawer
        ? { ...snapshot.layout, sidebarAnchored: false, sidebarCollapsed: false }
        : snapshot.layout)} style={{ height: "100%", minHeight: 0 }}>
        <ShellSidebar/>
        <ShellMainContent legacyRefs={legacyRefs}/>
        <EmployeeProfileHost mobile={snapshot.viewport.mobile}/>
      </Layout>
    </Layout>
  );
}

/** Stable shell composition boundary used by the browser migration adapter. */
export function ShellApp({ store, legacyRefs }: ShellAppProps) {
  React.useLayoutEffect(() => installSidebarStyles(), []);
  return (
    <WandUiProvider>
      <UiStoreProvider store={store}>
        <ShellAppFrame legacyRefs={legacyRefs}/>
      </UiStoreProvider>
    </WandUiProvider>
  );
}
