import { useSidebarPopupOwner, useSidebarPopupState } from "./sidebar-popup-owner";
import * as React from "react";
import { WandIcon, WandIconButton, WandMenuItem, WandPopover } from "../ui";
import { useSessionMove } from "./session-move";
import type { TaskDirectoryGroup } from "./types";

/** Keyboard/touch alternative to dragging; destinations always come from the same task list. */
export function SessionMoveButton({ sessionId, taskId, className, intoNewTask, menuItem = false, onMoved }: {
  sessionId: string;
  taskId?: string;
  className?: string;
  menuItem?: boolean;
  onMoved?(): void;
  /** Optional source directory before destinations have loaded. */
  intoNewTask?: TaskDirectoryGroup;
}): React.ReactElement {
  const popupOwner = useSidebarPopupOwner();
  const [open, setOpen] = useSidebarPopupState();
  const { targets, loading, busy, error, move, summarize, retry } = useSessionMove({
    sessionId, taskId, intoNewTask, open, onMoved: () => { setOpen(false); onMoved?.(); },
  });

  return <WandPopover popupOwner={popupOwner} open={open} onOpenChange={setOpen} align="end" contentRole="menu"
    ariaLabel="移动会话到分区" className="workspace-session-move-menu"
    trigger={menuItem ? <WandMenuItem label="移动到分区…" icon="folder" disabled={busy}/> :
      <WandIconButton className={className} title="移动到其他分区" aria-label="移动到其他分区" disabled={busy}>
        <WandIcon name="folder" size={13}/>
      </WandIconButton>}>
    <p className="workspace-session-move-hint">移动归属 · 保留运行目录</p>
    <WandMenuItem disabled={busy} label="新建分区并移入" icon="plus"
      onClick={() => { void summarize(); }}/>
    {error ? <p role="alert">{error}<WandMenuItem label="重新加载分区" disabled={busy || loading} onClick={retry}/></p> : null}
    {loading ? <p role="status">正在加载分区…</p> : targets.length === 0
      ? <p>还没有其他分区。</p> : targets.map((target) => <WandMenuItem key={target.id} disabled={busy} label={target.label} icon="folder"
        onClick={() => { void move(target.id); }}/>)}
  </WandPopover>;
}
