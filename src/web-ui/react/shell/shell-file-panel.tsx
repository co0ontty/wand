import * as React from "react";

import { classNames } from "../ui/class-names";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";

export function normalizeFilePanelCwd(raw: string): string {
  let cwd = raw.trim();
  if (!cwd) return "";
  cwd = cwd.replace(/\/{2,}/g, "/");
  cwd = cwd.replace(/\/+$/, "");
  if (!cwd) return "/";
  return cwd;
}

export function getParentFilePanelCwd(raw: string): string {
  const cwd = normalizeFilePanelCwd(raw);
  if (cwd === "/" || !cwd) return "/";
  const parent = cwd.slice(0, cwd.lastIndexOf("/"));
  return parent || "/";
}

export interface ShellFilePanelProps {
  suspended?: boolean;
  /** Stable bridge root; FileExplorerHost owns the file tree's React children. */
  explorerRef?: React.Ref<HTMLDivElement>;
}

/**
 * 文件面板的外壳：背景遮罩与旧版文件树宿主常驻，
 * 抽屉本体（antd Drawer）只在真的打开文件面板时才下载。
 */
export function ShellFilePanel({ explorerRef, suspended = false }: ShellFilePanelProps = {}) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const open = snapshot.layout.filePanelOpen && !suspended;
  const [Drawer, setDrawer] = React.useState<React.ComponentType<{ explorerRef?: React.Ref<HTMLDivElement>; suspended?: boolean }> | null>(null);
  React.useEffect(() => {
    if (!open || Drawer) return;
    let alive = true;
    void import("./shell-file-panel-drawer").then(module => {
      if (alive) setDrawer(() => module.ShellFilePanelDrawer);
    });
    return () => { alive = false; };
  }, [open, Drawer]);
  return (
    <>
      <div
        id="file-panel-backdrop"
        className={classNames("file-panel-backdrop", snapshot.layout.filePanelBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => { void dispatch({ type: "layout.files.close" }); }}
        hidden
      />
      <div className="file-explorer legacy-file-explorer-host" id="file-explorer" ref={explorerRef} hidden aria-hidden="true" />
      {Drawer ? <Drawer explorerRef={explorerRef} suspended={suspended}/> : null}
    </>
  );
}
