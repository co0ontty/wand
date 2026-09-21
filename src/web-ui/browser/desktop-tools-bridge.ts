/** Narrow navigation port for desktop clients. It never changes authentication or data. */
export interface DesktopToolsNavigation {
  openFiles(): boolean;
  getCloseState(): "ready" | "unsaved" | "busy";
  getSelectedSessionId(): string;
}

interface DesktopToolsRuntime {
  isReady(): boolean;
  setFilePanelOpen(open: boolean): void;
  hasUnsavedFiles(): boolean;
  isSavingFile(): boolean;
  getSelectedSessionId(): string;
}

export function createDesktopToolsNavigation(runtime: DesktopToolsRuntime): DesktopToolsNavigation {
  return {
    openFiles(): boolean {
      if (!runtime.isReady()) return false;
      runtime.setFilePanelOpen(true);
      return true;
    },
    getCloseState() {
      if (runtime.isSavingFile()) return "busy";
      return runtime.hasUnsavedFiles() ? "unsaved" : "ready";
    },
    getSelectedSessionId() {
      return runtime.isReady() ? runtime.getSelectedSessionId() : "";
    },
  };
}

declare global {
  interface Window {
    __wandDesktopTools?: DesktopToolsNavigation;
  }
}
