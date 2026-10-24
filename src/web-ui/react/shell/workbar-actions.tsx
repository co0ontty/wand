import * as React from "react";
import { WandDropdownMenu, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator, WandDropdownMenuTrigger } from "../ui/dropdown-menu";
import { WandIcon } from "../ui/icons";
import { WandIconButton } from "../ui/button";
import { QuickTerminalButton } from "../quick-terminal/action";
import { localPreviewController } from "../local-preview/controller";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { getShellSidebarEntryActions } from "./shell-sidebar";
import { TopbarMoreMenu } from "./shell-topbar";
import { TopbarGitMenuItem } from "./topbar-git-badge";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import { SidebarToggleIcon } from "./sidebar-toggle-icon";

/** Shared session actions. The owning task controller supplies only its own window actions. */
export function WorkbarActions({ windowActions }: { windowActions?: (close: () => void) => React.ReactNode }) {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const context = React.useSyncExternalStore(workspaceContextStore.subscribe, workspaceContextStore.getSnapshot, workspaceContextStore.getServerSnapshot);
  const [open, setOpen] = React.useState(false);
  const menuTrigger = React.useRef<HTMLButtonElement>(null);
  const split = context.layout?.windows.find(window => window.id === context.layout?.activeWindowId)?.layout.type === "split";
  React.useEffect(() => setOpen(false), [snapshot.selected?.id, context.taskId, context.layout?.activeWindowId]);
  const close = () => setOpen(false);
  const run = (action: Parameters<typeof dispatch>[0]) => { close(); menuTrigger.current?.focus({ preventScroll: true }); void dispatch(action); };
  return <div className="workbar-actions">
    <QuickTerminalButton/>
    <WandDropdownMenu open={open} onOpenChange={setOpen}>
      <WandDropdownMenuTrigger ref={menuTrigger} render={<WandIconButton aria-label="当前会话与窗口操作" title="更多操作"><WandIcon name="more" size={18}/></WandIconButton>}/>
      <WandDropdownMenuContent align="end" aria-label="当前会话与窗口操作">
        <WandDropdownMenuItem icon="explorer" onSelect={() => run({ type: "layout.files.toggle" })}>{snapshot.layout.filePanelOpen ? "关闭文件面板" : "文件"}</WandDropdownMenuItem>
        <WandDropdownMenuItem icon="eye" onSelect={() => { close(); localPreviewController.show(); }}>本地预览</WandDropdownMenuItem>
        <TopbarGitMenuItem id="workspace-tab-git-badge"/>
        {snapshot.selected && <><WandDropdownMenuSeparator/>
          <TopbarMoreMenu selected={snapshot.selected} actions={getShellSidebarEntryActions(snapshot.selected, false)} onAction={run} terminalControls={!split}/>
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
