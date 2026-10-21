import * as React from "react";
import { WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator, WandDropdownMenuTrigger } from "../ui/dropdown-menu";
import { WandIcon } from "../ui/icons";
import { WandIconButton } from "../ui/button";
import { QuickTerminalButton } from "../quick-terminal/action";
import { localPreviewController } from "../local-preview/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { getShellSidebarEntryActions } from "./shell-sidebar";
import { TopbarMoreMenu } from "./shell-topbar";
import { TopbarGitBadge } from "./topbar-git-badge";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";

/** Shared session actions. The owning task controller supplies only its own window actions. */
export function WorkbarActions({ windowActions }: { windowActions?: (close: () => void) => React.ReactNode }) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const context = React.useSyncExternalStore(workspaceContextStore.subscribe, workspaceContextStore.getSnapshot, workspaceContextStore.getServerSnapshot);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(false), [snapshot.selected?.id, context.taskId, context.layout?.activeWindowId]);
  const close = () => setOpen(false);
  const run = (action: Parameters<typeof dispatch>[0]) => { close(); void dispatch(action); };
  return <div className="workbar-actions">
    <span className="workbar-secondary-action"><TopbarGitBadge id="workspace-tab-git-badge"/></span>
    <QuickTerminalButton/>
    <WandIconButton className="workbar-secondary-action" aria-label="文件" title="打开文件面板" aria-pressed={snapshot.layout.filePanelOpen}
      onClick={() => void dispatch({ type: "layout.files.toggle" })}><WandIcon name="explorer" size={18}/></WandIconButton>
    <WandDropdownMenu open={open} onOpenChange={setOpen}>
      <WandDropdownMenuTrigger render={<WandIconButton aria-label="当前会话与窗口操作" title="更多操作"><WandIcon name="more" size={18}/></WandIconButton>}/>
      <WandDropdownMenuContent align="end" aria-label="当前会话与窗口操作">
        <WandDropdownMenuItem icon="explorer" onSelect={() => run({ type: "layout.files.toggle" })}>文件</WandDropdownMenuItem>
        <WandDropdownMenuItem icon="eye" onSelect={() => { close(); localPreviewController.show(); }}>本地预览</WandDropdownMenuItem>
        {snapshot.topbar.git && <WandDropdownMenuItem icon="git" onSelect={() => run({ type: "topbar.gitCommit" })}>快捷提交 · {snapshot.topbar.git.branch}</WandDropdownMenuItem>}
        {snapshot.selected && <><WandDropdownMenuSeparator/>
          <TopbarMoreMenu selected={snapshot.selected} actions={getShellSidebarEntryActions(snapshot.selected, false)} onAction={run}/>
        </>}
        {windowActions && <><WandDropdownMenuSeparator/>{windowActions(close)}</>}
      </WandDropdownMenuContent>
    </WandDropdownMenu>
  </div>;
}

export function WorkbarLeading() {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  return (snapshot.layout.sidebarDrawer || !snapshot.layout.sidebarAnchored) ? <WandIconButton
    aria-label={snapshot.layout.sessionsDrawerOpen ? "关闭会话侧栏" : "打开会话侧栏"}
    aria-expanded={snapshot.layout.sessionsDrawerOpen} aria-controls="sessions-drawer"
    onClick={() => void dispatch({ type: "layout.drawer.toggle" })}><SidebarToggleIcon open={snapshot.layout.sessionsDrawerOpen} size={18}/></WandIconButton> : null;
}
