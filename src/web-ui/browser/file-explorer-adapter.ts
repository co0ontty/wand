import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileExplorerHost } from "../react/file-explorer/host";
import { fileExplorerController } from "../react/file-explorer/controller";
import { isBrowserReactShellMounted } from "./shell-runtime";

let explorerRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

export function mountFileExplorerHost(container: HTMLElement, cwd: string): void {
  if (isBrowserReactShellMounted()) {
    // React Shell owns the file explorer slot; this adapter is disabled.
    return;
  }

  if (explorerRoot && mountedContainer === container) {
    // Already mounted, just update the cwd
    fileExplorerController.setRoot(cwd);
    return;
  }

  // Clean up old mount if container changed
  if (explorerRoot && mountedContainer !== container) {
    unmountFileExplorerHost();
  }

  mountedContainer = container;
  explorerRoot = createRoot(container);
  explorerRoot.render(React.createElement(FileExplorerHost, { root: cwd }));
}

function unmountFileExplorerHost(): void {
  if (explorerRoot) {
    explorerRoot.unmount();
    explorerRoot = null;
  }
  mountedContainer = null;
}

export function updateFileExplorerCwd(cwd: string): void {
  if (explorerRoot && mountedContainer) {
    fileExplorerController.setRoot(cwd);
  }
}
