import { useSidebarPopupOwner, useSidebarPopupState } from "./sidebar-popup-owner";
import * as React from "react";
import { WandIcon, WandIconButton, WandMenuItem, WandPopover } from "../ui";
import { describeError } from "../errors";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
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
  const [targets, setTargets] = React.useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void httpWorkspacesRepository.listTaskGroups().then(({ groups }) => {
      if (cancelled) return;
      setTargets(groups.flatMap((group) => group.tasks.filter((task) => task.id !== taskId)
        .map((task) => ({ id: task.id, label: `${group.workspaceName} / ${task.name}` }))));
    }).catch((cause) => {
      if (!cancelled) setError(describeError(cause, "无法加载任务。"));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, taskId]);

  const summarizeIntoNewTask = async (): Promise<void> => {
    if (!intoNewTask) return;
    setBusy(true);
    setError("");
    try {
      // 合成目录和隐藏全局空间没有可建任务的项目实体，改用独立任务挂载会话所在目录。
      const created = intoNewTask.synthetic || intoNewTask.global
        ? await httpWorkspacesRepository.createStandaloneTask({
          worktree: false, cwd: intoNewTask.workspaceCwd,
        })
        : await httpWorkspacesRepository.createTask(intoNewTask.workspaceId, { worktree: false });
      await httpWorkspacesRepository.moveSession(created.id, sessionId);
      setOpen(false);
      onMoved?.();
      workspacesStore.getRuntime()?.toast("已归纳为新任务，稍后按会话内容自动命名", "success");
      await workspacesStore.getRuntime()?.refreshSessions();
    } catch (cause) {
      setError(describeError(cause, "无法归纳为新任务。"));
    } finally {
      setBusy(false);
    }
  };

  return <WandPopover popupOwner={popupOwner} open={open} onOpenChange={setOpen} align="end" contentRole="menu"
    ariaLabel="移动会话到任务" className="workspace-session-move-menu"
    trigger={menuItem ? <WandMenuItem label="移动到任务…" icon="folder" disabled={busy}/> :
      <WandIconButton className={className} title="移动到其他任务" aria-label="移动到其他任务" disabled={busy}>
        <WandIcon name="folder" size={13}/>
      </WandIconButton>}>
    <p className="workspace-session-move-hint">移动归属 · 保留运行目录</p>
    {intoNewTask ? <WandMenuItem disabled={busy} label="归纳为新任务" icon="plus"
      onClick={() => { void summarizeIntoNewTask(); }}/> : null}
    {loading ? <p role="status">正在加载任务…</p> : error ? <p role="alert">{error}</p> : targets.length === 0
      ? <p>请先创建另一个任务。</p> : targets.map((target) => <WandMenuItem key={target.id} disabled={busy} label={target.label} icon="folder"
        onClick={() => {
          setBusy(true);
          void httpWorkspacesRepository.moveSession(target.id, sessionId).then(async () => {
            setOpen(false);
            onMoved?.();
            workspacesStore.getRuntime()?.toast(`已移至 ${target.label}，运行目录不变`, "success");
            await workspacesStore.getRuntime()?.refreshSessions();
          }).catch((cause) => setError(describeError(cause, "无法移动会话。")))
            .finally(() => setBusy(false));
        }}/>)}
  </WandPopover>;
}
