import * as React from "react";

import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

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

function FileIcon({ name, size = 16 }: {
  name: "close" | "folder" | "refresh" | "search" | "up";
  size?: number;
}) {
  const common = {
    className: `wand-icon wand-icon-${name}`,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "close": return <svg {...common}><path d="M18 6L6 18M6 6l12 12"/></svg>;
    case "folder": return <svg {...common} className="wand-icon wand-icon-folder-open"><path d="M6 14l1.5-3A2 2 0 019.2 10H20a2 2 0 011.9 2.5l-1.5 6A2 2 0 0118.4 20H4a2 2 0 01-2-2V5a2 2 0 012-2h4l3 3h7a2 2 0 012 2v2"/></svg>;
    case "refresh": return <svg {...common}><path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5"/></svg>;
    case "search": return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>;
    case "up": return <svg {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>;
  }
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
  const [search, setSearch] = React.useState("");
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
            <span className="file-side-panel-icon"><FileIcon name="folder"/></span>
            <span className="file-side-panel-title">文件</span>
          </div>
          <div className="file-side-panel-header-actions">
            <button
              className="file-side-panel-iconbtn"
              id="file-explorer-refresh"
              type="button"
              title="刷新"
              aria-label="刷新文件列表"
              onClick={() => void dispatch({ type: "layout.files.refresh" })}
            >
              <FileIcon name="refresh" size={15}/>
            </button>
            <button
              id="file-side-panel-close"
              className="file-side-panel-iconbtn close"
              type="button"
              aria-label="关闭文件面板"
              title="关闭"
              onClick={() => void dispatch({ type: "layout.files.close" })}
            >
              <FileIcon name="close"/>
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
              <FileIcon name="up" size={15}/>
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
          <div className="file-search-box">
            <span className="file-search-icon"><FileIcon name="search" size={14}/></span>
            <input
              type="text"
              id="file-search-input"
              className="file-search-input"
              value={search}
              placeholder="搜索当前目录…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="搜索当前目录"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setSearch(next);
                void dispatch({ type: "layout.files.search", query: next.trim() });
              }}
            />
            <button
              className={classNames("file-search-clear", search.trim() && "visible")}
              id="file-search-clear"
              type="button"
              aria-label="清除搜索"
              title="清除"
              disabled={!search}
              onClick={() => {
                setSearch("");
                void dispatch({ type: "layout.files.search.clear" });
              }}
            >
              <FileIcon name="close" size={13}/>
            </button>
          </div>
          <div className="file-explorer" id="file-explorer" ref={explorerRef}/>
        </div>
      </div>
    </>
  );
}
