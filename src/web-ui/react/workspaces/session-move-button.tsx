import * as React from "react";
import { WandIcon, WandIconButton, WandMenuItem, WandPopover } from "../ui";
import { describeError } from "../errors";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";

/** Keyboard/touch alternative to dragging; destinations always come from the same task list. */
export function SessionMoveButton({ sessionId, taskId, className }: {
  sessionId: string;
  taskId?: string;
  className?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
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

  return <WandPopover open={open} onOpenChange={setOpen} align="end" contentRole="menu"
    ariaLabel="移动会话到任务" className="workspace-session-move-menu"
    trigger={<WandIconButton className={className} title="移动到其他任务" aria-label="移动到其他任务" disabled={busy}>
      <WandIcon name="folder" size={13}/>
    </WandIconButton>}>
    <p className="workspace-session-move-hint">移动归属 · 保留运行目录</p>
    {loading ? <p role="status">正在加载任务…</p> : error ? <p role="alert">{error}</p> : targets.length === 0
      ? <p>请先创建另一个任务。</p> : targets.map((target) => <WandMenuItem key={target.id} disabled={busy} label={target.label} icon="folder"
        onClick={() => {
          setBusy(true);
          void httpWorkspacesRepository.moveSession(target.id, sessionId).then(async () => {
            setOpen(false);
            workspacesStore.getRuntime()?.toast(`已移至 ${target.label}，运行目录不变`, "success");
            await workspacesStore.getRuntime()?.refreshSessions();
          }).catch((cause) => setError(describeError(cause, "无法移动会话。")))
            .finally(() => setBusy(false));
        }}/>)}
  </WandPopover>;
}
