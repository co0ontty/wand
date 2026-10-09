import * as React from "react";
import { WandIcon } from "../ui";
import { describeError } from "../errors";
import { SidebarRowMenu } from "./sidebar-row-menu";
import { useSidebarPopupState } from "./sidebar-popup-owner";
import { useSessionMove } from "./session-move";
import { confirmSessionDelete } from "./session-delete-confirm";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "./types";

/** Both sidebar projections use one action list, including archived sessions. */
export function SidebarSessionMenu({ row, session, label, disabled, intoNewTask, onOpen, onArchive, onDelete }: {
  row: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>;
  session: WorkspaceSessionSummary;
  label: string;
  disabled?: boolean;
  intoNewTask?: TaskDirectoryGroup;
  onOpen(): void;
  onArchive?(archived: boolean): Promise<void>;
  onDelete?(): Promise<void>;
}): React.ReactElement {
  const [open, setOpen] = useSidebarPopupState();
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [action, setAction] = React.useState<"archive" | "delete" | null>(null);
  const [error, setError] = React.useState("");
  const lock = React.useRef(false);
  const rowRef = React.useRef<HTMLElement>(null);
  const archived = session.archived === true;
  const move = useSessionMove({ sessionId: session.id, taskId: session.workspaceTaskId, intoNewTask,
    open: open && moveOpen, onMoved: () => setOpen(false) });
  const busy = action !== null || move.busy;
  React.useEffect(() => { if (!open) setMoveOpen(false); }, [open]);
  const run = async (kind: "archive" | "delete"): Promise<void> => {
    if (lock.current || busy) return;
    lock.current = true; setError("");
    try {
      if (kind === "delete") {
        setOpen(false);
        // The menu item will unmount; let the dialog restore the actual row control instead.
        rowRef.current?.querySelector<HTMLElement>("button,a[href]")?.focus({ preventScroll: true });
        if (!await confirmSessionDelete(label)) return;
      }
      setAction(kind);
      if (kind === "archive") await onArchive?.(!archived); else await onDelete?.();
      setOpen(false);
    } catch (cause) {
      setError(describeError(cause, kind === "delete" ? "无法删除会话。" : archived ? "无法恢复会话。" : "无法归档会话。"));
      // A late failure must not reopen an old menu after the user has moved on.
      // Deletion replaces the menu with a dialog; reopen only if focus still belongs to this row.
      if (kind === "delete" && rowRef.current?.contains(document.activeElement)) setOpen(true);
    } finally { lock.current = false; setAction(null); }
  };
  return <SidebarRowMenu row={React.cloneElement(row, { "aria-busy": busy || undefined,
    draggable: busy ? false : row.props.draggable })} rowRef={rowRef} disabled={disabled}
    open={open} onOpenChange={next => { if (!next || !busy) setOpen(next); }}
    label={`会话 ${label} 的操作`} title={label} description={archived ? "已归档会话" : undefined}
    className="workspace-session-menu" error={error}
    menu={{
      // Ant's non-selectable multi mode keeps a destination submenu open until the
      // async move succeeds; errors and retries stay in that same visible surface.
      multiple: true,
      onOpenChange: keys => { setMoveOpen(keys.includes("move")); if (keys.includes("move")) setError(""); },
      items: [
        { key: "open", disabled: busy, icon: <WandIcon name="chat"/>, label: "打开会话" },
        ...(!archived ? [{ key: "move", disabled: busy, icon: <WandIcon name="folder"/>, label: "移动到任务",
          popupClassName: "workspace-session-move-menu", children: [
            { key: "move-context", type: "group" as const, label: "保留运行目录", children: [] },
            ...(intoNewTask ? [{ key: "new-task", disabled: busy, icon: <WandIcon name="plus"/>, label: move.busy ? "正在移动…" : "归纳为新任务" },
              { key: "move-divider", type: "divider" as const }] : []),
            ...(move.loading ? [{ key: "loading", disabled: true, label: <span role="status">正在加载任务…</span> }]
              : move.targets.length ? move.targets.map(target => ({ key: `target:${target.id}`, disabled: busy,
                icon: <WandIcon name="folder"/>, label: target.label, title: target.label }))
                : !move.error ? [{ key: "empty", disabled: true, label: "请先创建另一个任务。" }] : []),
            ...(move.error ? [{ key: "move-error", disabled: true, label: <span role="alert" className="sidebar-menu-error">{move.error}</span> },
              { key: "retry", disabled: busy || move.loading, icon: <WandIcon name="refresh"/>, label: "重新加载任务" }] : []),
          ] }] : []),
        ...(onArchive ? [{ key: "archive", disabled: busy, icon: <WandIcon name={archived ? "resume" : "archive"}/>,
          label: action === "archive" ? archived ? "正在恢复…" : "正在归档…" : archived ? "恢复会话" : "归档会话" }] : []),
        ...(onDelete ? [{ key: "danger-divider", type: "divider" as const },
          { key: "delete", disabled: busy, danger: true, icon: <WandIcon name="trash"/>, label: "删除会话…" }] : []),
      ],
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        if (busy) return;
        setError("");
        if (key === "open") { setOpen(false); onOpen(); }
        else if (key === "archive" || key === "delete") void run(key);
        else if (key === "new-task") void move.summarize();
        else if (key === "retry") move.retry();
        else if (key.startsWith("target:")) void move.move(key.slice("target:".length));
      },
    }}/>;
}
