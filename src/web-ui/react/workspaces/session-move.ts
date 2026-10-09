import * as React from "react";
import { describeError } from "../errors";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import type { TaskDirectoryGroup } from "./types";

/** Shared by the sidebar's native submenu and the task board's move picker. */
export function useSessionMove({ sessionId, taskId, intoNewTask, open, onMoved }: {
  sessionId: string;
  taskId?: string;
  intoNewTask?: TaskDirectoryGroup;
  open: boolean;
  onMoved?(): void;
}) {
  const [targets, setTargets] = React.useState<Array<{ id: string; label: string }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reloadKey, setReloadKey] = React.useState(0);
  const running = React.useRef(false);
  const createdTask = React.useRef<{ sessionId: string; workspaceId: string; id: string } | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError("");
    void httpWorkspacesRepository.listTaskGroups().then(({ groups }) => {
      if (!cancelled) setTargets(groups.flatMap(group => group.tasks.filter(task => task.id !== taskId)
        .map(task => ({ id: task.id, label: `${group.workspaceName} / ${task.name}` }))));
    }).catch(cause => { if (!cancelled) setError(describeError(cause, "无法加载任务。")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, taskId, reloadKey]);

  const run = async (operation: () => Promise<void>, success: string, failure: string): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      await operation();
    } catch (cause) {
      setError(describeError(cause, failure));
      running.current = false; setBusy(false);
      return;
    }
    onMoved?.();
    const runtime = workspacesStore.getRuntime();
    runtime?.toast(success, "success");
    // A refresh failure is not a failed move: do not offer to repeat an accepted mutation.
    try { await runtime?.refreshSessions(); }
    catch (cause) { runtime?.toast(describeError(cause, "归属已更新，但列表刷新失败，请刷新列表。"), "danger"); }
    finally { running.current = false; setBusy(false); }
  };
  const move = (id: string): Promise<void> => {
    const target = targets.find(candidate => candidate.id === id);
    if (!target) return Promise.resolve();
    return run(() => httpWorkspacesRepository.moveSession(id, sessionId), `已移至 ${target.label}，运行目录不变`, "无法移动会话。");
  };
  const summarize = (): Promise<void> => {
    if (!intoNewTask) return Promise.resolve();
    return run(async () => {
      // If creation succeeded but attachment failed, retry attachment to that same task.
      // Do not create another empty task on every click of the retry action.
      if (createdTask.current?.sessionId !== sessionId || createdTask.current.workspaceId !== intoNewTask.workspaceId) {
        const created = intoNewTask.synthetic || intoNewTask.global
          ? await httpWorkspacesRepository.createStandaloneTask({ worktree: false, cwd: intoNewTask.workspaceCwd })
          : await httpWorkspacesRepository.createTask(intoNewTask.workspaceId, { worktree: false });
        createdTask.current = { sessionId, workspaceId: intoNewTask.workspaceId, id: created.id };
      }
      await httpWorkspacesRepository.moveSession(createdTask.current.id, sessionId);
      createdTask.current = null;
    }, "已归纳为新任务，稍后按会话内容自动命名", "无法归纳为新任务。");
  };
  return { targets, loading, busy, error, move, summarize, retry: () => setReloadKey(key => key + 1) };
}
