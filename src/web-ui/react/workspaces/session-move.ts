import { createWorkspaceSection } from "./section-create";
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
  const origin = React.useRef<TaskDirectoryGroup | undefined>(intoNewTask);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError("");
    void httpWorkspacesRepository.listTaskGroups().then(({ groups }) => {
      if (!cancelled) {
        origin.current = groups.find(group => group.standaloneSessions.some(session => session.id === sessionId)
          || group.tasks.some(task => task.sessions.some(session => session.id === sessionId))) ?? intoNewTask;
        setTargets([
          ...(taskId ? [{ id: "ungrouped", label: "移回工作区（不分区）" }] : []),
          ...groups.flatMap(group => group.tasks.filter(task => task.id !== taskId)
            .map(task => ({ id: task.id, label: `${group.workspaceName} / ${task.kind === "section" ? "" : "任务 · "}${task.name}` }))),
        ]);
      }
    }).catch(cause => { if (!cancelled) setError(describeError(cause, "无法加载分区。")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, taskId, sessionId, reloadKey]);

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
    return run(() => id === "ungrouped" ? httpWorkspacesRepository.unassignSession(sessionId) : httpWorkspacesRepository.moveSession(id, sessionId), `已移至 ${target.label}，运行目录不变`, "无法移动会话。");
  };
  const summarize = async (): Promise<void> => {
    const group = origin.current;
    if (!group || running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      const created = await createWorkspaceSection(group, sessionId);
      if (!created) return;
      onMoved?.();
      await workspacesStore.getRuntime()?.refreshSessions();
    } catch (cause) { setError(describeError(cause, "无法创建分区。")); }
    finally { running.current = false; setBusy(false); }
  };
  return { targets, loading, busy, error, move, summarize, retry: () => setReloadKey(key => key + 1) };
}
