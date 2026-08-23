import * as React from "react";

import { WandIcon } from "../ui";
import { classNames } from "../ui/class-names";
import { fileExplorerController } from "../file-explorer/controller";
import { FileExplorerHost } from "../file-explorer/host";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";

export function normalizeFilePanelCwd(raw: string): string {
  let cwd = raw.trim();
  if (!cwd) return "";
  cwd = cwd.replace(/\/{2,}/g, "/");
  if (cwd.length > 1) cwd = cwd.replace(/\/+$/, "");
  return cwd;
}

export function getParentFilePanelCwd(raw: string): string {
  const cwd = normalizeFilePanelCwd(raw);
  if (!cwd || cwd === "/") return cwd || "/";
  const parent = cwd.replace(/\/[^/]+$/, "");
  return parent || "/";
}

export interface ShellFilePanelProps {
  /** Ref used by the legacy file-tree host. React never renders slot children. */
  explorerRef?: React.Ref<HTMLDivElement>;
}

export function ShellFilePanel({ explorerRef }: ShellFilePanelProps = {}) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const snapshotCwd = normalizeFilePanelCwd(snapshot.topbar.cwd) || "/";
  const [cwd, setCwd] = React.useState(snapshotCwd);
  const committedCwd = React.useRef(snapshotCwd);
  const editingCwd = React.useRef(false);

  React.useEffect(() => {
    if (editingCwd.current) return;
    committedCwd.current = snapshotCwd;
    setCwd(snapshotCwd);
  }, [snapshot.selected?.id, snapshotCwd]);

  const commitCwd = React.useCallback(() => {
    const normalized = normalizeFilePanelCwd(cwd);
    if (!normalized) {
      setCwd(committedCwd.current);
      return;
    }
    setCwd(normalized);
    if (normalized === committedCwd.current) return;
    committedCwd.current = normalized;
    void dispatch({ type: "layout.files.navigate", cwd: normalized });
  }, [cwd, dispatch]);

  const parentCwd = getParentFilePanelCwd(committedCwd.current);
  return (
    <>
      <div
        id="file-panel-backdrop"
        className={classNames("file-panel-backdrop", snapshot.layout.filePanelBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => void dispatch({ type: "layout.files.close" })}
      />
      <div
        id="file-side-panel"
        className={classNames("file-side-panel", snapshot.layout.filePanelOpen && "open")}
        aria-hidden={!snapshot.layout.filePanelOpen}
      >
        <div className="file-side-panel-header">
          <div className="file-side-panel-title-group">
            <span className="file-side-panel-icon"><WandIcon name="explorer" size={16} className="wand-icon wand-icon-explorer"/></span>
            <span className="file-side-panel-title">文件</span>
          </div>
          <div className="file-side-panel-header-actions">
            <button
              className="file-side-panel-iconbtn"
              id="file-explorer-refresh"
              type="button"
              title="刷新"
              aria-label="刷新文件列表"
              onClick={() => {
                void fileExplorerController.execute({ type: "refresh" });
                void dispatch({ type: "layout.files.refresh" });
              }}
            >
              <WandIcon name="refresh" size={15} className="wand-icon wand-icon-refresh"/>
            </button>
            <button
              id="file-side-panel-close"
              className="file-side-panel-iconbtn close"
              type="button"
              aria-label="关闭文件面板"
              title="关闭"
              onClick={() => void dispatch({ type: "layout.files.close" })}
            >
              <WandIcon name="close" size={16} className="wand-icon wand-icon-close"/>
            </button>
          </div>
        </div>
        <div className="file-side-panel-body">
          <div className="file-explorer-header">
            <button
              className="file-explorer-up"
              id="file-explorer-up"
              type="button"
              title="返回上级目录"
              aria-label="返回上级目录"
              disabled={committedCwd.current === "/"}
              onClick={() => {
                if (parentCwd === committedCwd.current) return;
                committedCwd.current = parentCwd;
                setCwd(parentCwd);
                void dispatch({ type: "layout.files.up" });
              }}
            >
              <WandIcon name="up" size={15} className="wand-icon wand-icon-up"/>
            </button>
            <input
              type="text"
              className="file-explorer-path"
              id="file-explorer-cwd"
              value={cwd}
              title={cwd}
              placeholder="输入路径并回车..."
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="当前路径，可直接修改后回车"
              onFocus={(event) => {
                editingCwd.current = true;
                event.currentTarget.select();
              }}
              onChange={(event) => setCwd(event.currentTarget.value)}
              onBlur={() => {
                editingCwd.current = false;
                commitCwd();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCwd();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  editingCwd.current = false;
                  setCwd(committedCwd.current);
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
          <div
            className="file-explorer legacy-file-explorer-host"
            id="file-explorer"
            ref={explorerRef}
            hidden
            aria-hidden="true"
          />
          <FileExplorerHost root={committedCwd.current}/>
        </div>
      </div>
    </>
  );
}
