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
  /**
   * 未分组会话专属：就地建一张空任务卡再把会话移进去。任务名先取会话内容做临时标题，
   * 之后由侧栏轮询的自动命名链路（refreshAutoBoardTaskTitles）交给模型改写。
   * 只有用户点这一次才建任务，会话本身不再被自动建任务。
   */
  intoNewTask?: TaskDirectoryGroup;
}): React.ReactElement {
  const popupOwner = useSidebarPopupOwner();
  const [open, setOpen] = useSidebarPopupState();
  const { targets, loading, busy, error, move, summarize, retry } = useSessionMove({
    sessionId, taskId, intoNewTask, open, onMoved: () => { setOpen(false); onMoved?.(); },
  });

  return <WandPopover popupOwner={popupOwner} open={open} onOpenChange={setOpen} align="end" contentRole="menu"
    ariaLabel="移动会话到任务" className="workspace-session-move-menu"
    trigger={menuItem ? <WandMenuItem label="移动到任务…" icon="folder" disabled={busy}/> :
      <WandIconButton className={className} title="移动到其他任务" aria-label="移动到其他任务" disabled={busy}>
        <WandIcon name="folder" size={13}/>
      </WandIconButton>}>
    <p className="workspace-session-move-hint">移动归属 · 保留运行目录</p>
    {intoNewTask ? <WandMenuItem disabled={busy} label="归纳为新任务" icon="plus"
      onClick={() => { void summarize(); }}/> : null}
    {error ? <p role="alert">{error}<WandMenuItem label="重新加载任务" disabled={busy || loading} onClick={retry}/></p> : null}
    {loading ? <p role="status">正在加载任务…</p> : targets.length === 0
      ? <p>请先创建另一个任务。</p> : targets.map((target) => <WandMenuItem key={target.id} disabled={busy} label={target.label} icon="folder"
        onClick={() => { void move(target.id); }}/>)}
  </WandPopover>;
}
