import * as React from "react";
import { PageRouteNotice } from "../page-route-notice";
import { EmployeeProfileHost } from "../agents/employee-profile";
import { Layout } from "antd";
import { WandUiProvider } from "../theme";
import { installSidebarStyles } from "./sidebar-styles";

import { ShellMainContent, type ShellMainContentRefs } from "./shell-main-content";
import { QuickTerminalWorkspace } from "../quick-terminal/workspace";
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
    <Layout className="app-container" style={{ position: "fixed", top: "calc(var(--app-viewport-top, 0px) + var(--conversation-frame-top, 0px))", left: "var(--conversation-frame-inline, 0px)", right: "var(--conversation-frame-inline, 0px)", height: "calc(var(--app-viewport-height, 100dvh) - var(--conversation-frame-top, 0px) - var(--conversation-frame-bottom, 0px))", overflow: "hidden", paddingTop: "var(--wand-safe-top, 0px)", paddingBottom: "var(--wand-safe-bottom, 0px)" }}>
      <PageRouteNotice/>
      <Layout hasSider className={getShellLayoutClassName(snapshot.layout.sidebarDrawer
        ? { ...snapshot.layout, sidebarAnchored: false, sidebarCollapsed: false }
        : snapshot.layout)} style={{ flex: 1, minHeight: 0 }}>
        <ShellSidebar/>
        <QuickTerminalWorkspace><ShellMainContent legacyRefs={legacyRefs}/></QuickTerminalWorkspace>
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
