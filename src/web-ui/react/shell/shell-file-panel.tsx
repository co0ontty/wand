import * as React from "react";
import { Drawer, Flex } from "antd";

import { WandInput, WandIcon, WandIconButton } from "../ui";
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
  suspended?: boolean;
  /** Stable bridge root; FileExplorerHost owns the file tree's React children. */
  explorerRef?: React.Ref<HTMLDivElement>;
}

export function ShellFilePanel({ explorerRef, suspended = false }: ShellFilePanelProps = {}) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const snapshotCwd = normalizeFilePanelCwd(snapshot.topbar.cwd) || "/";
  const [cwd, setCwd] = React.useState(snapshotCwd);
  // committedCwd 必须是 state：它是 FileExplorerHost 的 root，而 commitCwd 里
  // setCwd 往往与当前值相同（输入期间 onChange 已经同步过），用 ref 存
  // 时那次 setState 会被 React bail-out，root 就不会跟着变。
  const [committedCwd, setCommittedCwd] = React.useState(snapshotCwd);
  const editingCwd = React.useRef(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const returnFocus = React.useRef(false);
  React.useLayoutEffect(() => {
    if (snapshot.layout.filePanelOpen) triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [snapshot.layout.filePanelOpen]);
  const closePanel = (): void => {
    if (!snapshot.layout.filePanelOpen) return;
    returnFocus.current = true;
    void dispatch({ type: "layout.files.close" });
    if (!snapshot.viewport.mobile) triggerRef.current?.focus({ preventScroll: true });
  };

  React.useEffect(() => {
    if (editingCwd.current) return;
    setCommittedCwd(snapshotCwd);
    setCwd(snapshotCwd);
  }, [snapshot.selected?.id, snapshotCwd]);

  const commitCwd = React.useCallback(() => {
    const normalized = normalizeFilePanelCwd(cwd);
    if (!normalized) {
      setCwd(committedCwd);
      return;
    }
    setCwd(normalized);
    if (normalized === committedCwd) return;
    setCommittedCwd(normalized);
  }, [cwd, committedCwd]);

  const parentCwd = getParentFilePanelCwd(committedCwd);
  return (
    <>
      <div
        id="file-panel-backdrop"
        className={classNames("file-panel-backdrop", snapshot.layout.filePanelBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => void dispatch({ type: "layout.files.close" })}
        hidden
      />
      <div className="file-explorer legacy-file-explorer-host" id="file-explorer" ref={explorerRef} hidden aria-hidden="true" />
      <Drawer forceRender open={snapshot.layout.filePanelOpen && !suspended} title="文件" size={snapshot.viewport.mobile ? "100%" : 360}
        rootClassName="wand-file-drawer"
        mask={snapshot.layout.filePanelBackdropVisible} keyboard={snapshot.layout.filePanelOpen} onClose={closePanel} focusable={{ focusTriggerAfterClose: false }}
        afterOpenChange={(shown) => {
          if (shown || !returnFocus.current) return;
          returnFocus.current = false;
          const active = document.activeElement;
          if (active === document.body || active?.closest(".wand-file-drawer")) {
            triggerRef.current?.focus({ preventScroll: true });
          }
        }}
        closable={false} styles={{ body: { padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }, header: { paddingTop: "max(16px, var(--wand-safe-top, 0px))" } }}
        drawerRender={(node) => <div id="file-side-panel" className={classNames("file-side-panel", snapshot.layout.filePanelOpen && "open")} style={{ height: "100%" }}>{node}</div>}
        extra={<Flex align="center" gap="small" className="file-side-panel-header-actions">
            <WandIconButton
              className="file-side-panel-iconbtn"
              id="file-explorer-refresh"
              title="刷新"
              aria-label="刷新文件列表"
              onClick={() => {
                void fileExplorerController.execute({ type: "refresh" });
              }}
            >
              <WandIcon name="refresh" size={15} className="wand-icon wand-icon-refresh"/>
            </WandIconButton>
            <WandIconButton
              id="file-side-panel-close"
              className="file-side-panel-iconbtn close"
              aria-label="关闭文件面板"
              title="关闭"
              onClick={closePanel}
            >
              <WandIcon name="close" size={16} className="wand-icon wand-icon-close"/>
            </WandIconButton>
          </Flex>}
      >
        <Flex vertical gap="small" className="file-side-panel-body" style={{ flex: 1, minHeight: 0 }}>
          <Flex align="center" gap="small" className="file-explorer-header" style={{ flexShrink: 0 }}>
            <WandIconButton
              className="file-explorer-up"
              id="file-explorer-up"
              title="返回上级目录"
              aria-label="返回上级目录"
              disabled={committedCwd === "/"}
              onClick={() => {
                if (parentCwd === committedCwd) return;
                setCommittedCwd(parentCwd);
                setCwd(parentCwd);
              }}
            >
              <WandIcon name="up" size={15} className="wand-icon wand-icon-up"/>
            </WandIconButton>
            <WandInput
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
                // 输入法组字期间的回车/ESC 只属于候选词，不能把半截拼音当成路径提交。
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitCwd();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  editingCwd.current = false;
                  setCwd(committedCwd);
                  event.currentTarget.blur();
                }
              }}
            />
          </Flex>
          <FileExplorerHost root={committedCwd}/>
        </Flex>
      </Drawer>
    </>
  );
}
