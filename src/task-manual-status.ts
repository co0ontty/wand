import { randomUUID } from "node:crypto";
import { AI_TEAM_ACTIVE_RUN_STATUSES } from "./ai-team-types.js";
import { isArchiveBlocked } from "./archive-policy.js";
import { taskDispatchFence, taskStatusChangeKey, taskStatusChangeReceipt, waitForTaskDispatches, type TaskStatusChangeReceipt } from "./task-execution-fence.js";
import type { TaskRouteDependencies } from "./server-task-routes.js";
import type { WandTaskStatus } from "./task-types.js";
const operations = new WeakMap<object, Map<string, Promise<TaskStatusChangeReceipt>>>();

/** Explicit user status editing cancels the old execution generation before changing the phase. */
export function changeTaskStatus(deps: TaskRouteDependencies, taskId: string,
  input: { status: WandTaskStatus; expectedUpdatedAt: string; requestId?: string }): Promise<TaskStatusChangeReceipt> {
  const { storage } = deps;
  let active = operations.get(storage); if (!active) { active = new Map(); operations.set(storage, active); }
  const existing = active.get(taskId);
  if (existing) return Promise.reject(new Error("该任务正在停止旧执行，请等待本次操作结束。"));
  const execute = async (): Promise<TaskStatusChangeReceipt> => {
    const task = storage.getWandTask(taskId);
    if (!task) throw new Error("任务不存在。");
    if (!["backlog", "todo", "doing", "archived"].includes(input.status)) throw new Error("待验收与待归档请通过交付和独立验收流程操作。");
    const requestId = input.requestId || randomUUID(), prior = taskStatusChangeReceipt(storage, taskId);
    if (prior?.requestId === requestId && prior.state === "completed") {
      if (prior.status !== input.status) throw new Error("请求标识已用于其他状态。");
      return prior;
    }
    if (task.updatedAt !== input.expectedUpdatedAt) throw new Error("任务已有新进展，请刷新后重新选择状态。");
    if (task.status === input.status && prior?.state !== "failed") return { requestId, status: input.status, state: "completed", requestedAt: new Date().toISOString(), stoppedSessions: 0, cancelledDispatches: 0 };
    const receipt: TaskStatusChangeReceipt = { requestId, status: input.status, state: "stopping", requestedAt: new Date().toISOString(), stoppedSessions: 0, cancelledDispatches: 0 };
    const ids = new Set([taskId]);
    for (const id of ids) for (const child of storage.listWandTaskChildren(id)) ids.add(child.id);
    for (const id of ids) {
      if (active!.has(id) || id !== taskId && taskDispatchFence(storage, id).blocked) throw new Error("关联任务正在停止旧执行，请稍后重试。");
    }
    if (task.parentTaskId && taskDispatchFence(storage, task.parentTaskId).blocked) throw new Error("父任务正在停止旧执行，请稍后重试。");
    storage.setPreference(taskStatusChangeKey(taskId), receipt);
    try {
      for (const id of ids) receipt.cancelledDispatches += storage.cancelTaskStatusQueuedDispatches(id);
      await waitForTaskDispatches(storage, [...ids]);
      const runs = [...ids].flatMap(id => {
        const current = storage.getWandTask(id);
        return [id, current?.workspaceTaskId].flatMap(value => value ? storage.listAiTeamRuns({ taskId: value, statuses: AI_TEAM_ACTIVE_RUN_STATUSES }) : []);
      });
      for (const id of new Set(runs.map(run => run.id))) {
        if (!deps.aiTeams) throw new Error("团队执行器不可用，未修改状态。");
        await deps.aiTeams.stop(id);
      }
      const sessionIds = new Set([...ids].flatMap(id => [...storage.listWandTaskSessionIds(id), ...storage.taskStatusDispatchSessions(id)]));
      const barriers: Promise<void>[] = [];
      for (const id of sessionIds) {
        const session = deps.sessions?.getSlim(id) ?? storage.getSessionSlim(id);
        if (!session) continue;
        const owner = deps.sessions?.ownerOf(id);
        if (owner === "structured" && deps.structured) {
          if (isArchiveBlocked(session) || session.queuedMessages?.length) {
            const barrier = deps.structured.nativeHistoryCleanupBarrier(id);
            deps.structured.stop(id); deps.structured.clearQueuedMessages(id); receipt.stoppedSessions++;
            if (barrier) barriers.push(barrier);
          }
        } else if (owner === "pty" && deps.processes && (isArchiveBlocked(session) || session.providerCliActive)) {
          const barrier = deps.processes.nativeHistoryCleanupBarrier(id);
          deps.processes.stop(id); receipt.stoppedSessions++; if (barrier) barriers.push(barrier);
        } else if (isArchiveBlocked(session)) throw new Error("存在执行所有权尚未恢复的会话，无法确认停止，状态未修改。");
      }
      await Promise.all(barriers);
      for (const id of sessionIds) {
        const session = deps.sessions?.getSlim(id) ?? storage.getSessionSlim(id);
        if (session && isArchiveBlocked(session)) throw new Error("部分会话仍在执行或等待处理，状态未修改。");
      }
      storage.transaction(() => {
        const current = storage.getWandTask(taskId);
        if (!current || current.status !== task.status) throw new Error("停止期间任务阶段已变化，未覆盖新状态。");
        for (const id of ids) {
          receipt.cancelledDispatches += storage.cancelTaskStatusQueuedDispatches(id);
          storage.settleTaskStatusDispatches(id, [...sessionIds]);
          if (storage.taskHasUnsettledDispatch(id)) throw new Error("仍有未知送达且无法关联会话的派发，保留停止保护；请核对后重试。");
        }
        storage.updateWandTask(taskId, { status: input.status });
        receipt.state = "completed"; storage.setPreference(taskStatusChangeKey(taskId), receipt);
        storage.addSystemComment(taskId, "手动修改状态", `用户将任务状态改为 ${input.status}。已停止 ${receipt.stoppedSessions} 个执行会话，取消 ${receipt.cancelledDispatches} 条旧派发；等待下一轮巡检按新阶段判断，不立即重发。此操作不代表验收通过。`);
      });
      return receipt;
    } catch (cause) {
      receipt.state = "failed"; receipt.error = cause instanceof Error ? cause.message : "停止未确认，状态未修改。";
      storage.setPreference(taskStatusChangeKey(taskId), receipt); throw new Error(receipt.error);
    }
  };
  const operation = execute(); active.set(taskId, operation);
  void operation.finally(() => active!.delete(taskId)).catch(() => {});
  return operation;
}
