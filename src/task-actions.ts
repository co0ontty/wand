import { pendingSessionQuestions, sessionToolQuestions } from "./session-questions.js";
import { TaskReadModel } from "./task-read-model.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandStorage } from "./storage.js";
import type { TaskActionItem, TaskActionsSnapshot } from "./task-action-types.js";
import { taskAiVerified, taskHumanAccepted, type WandTask } from "./task-types.js";

const MAX_SESSIONS = 256;
const MAX_ITEMS = 512;
const MAX_TURNS = 128;
const MAX_BLOCKS = 2048;

/** Read-only, runtime-backed navigation. No stored transcript hydration, repair, or mutation. */
export function readTaskActions(storage: WandStorage, registry?: SessionRegistry, workspaceId?: string): TaskActionsSnapshot {
  const model = new TaskReadModel(storage, registry);
  const tasks = model.tasks.filter(task => task.status !== "archived" && (workspaceId === undefined || task.workspaceId === workspaceId));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const items = new Map<string, TaskActionItem>();
  let incompleteSources = 0;
  let sessionReads = 0;
  const add = (task: WandTask, kind: TaskActionItem["kind"], id: string, reason: string, source: TaskActionItem["source"] = {}): void => {
    const key = JSON.stringify([kind, task.id, id]);
    if (items.has(key)) return;
    if (items.size >= MAX_ITEMS) { incompleteSources++; return; }
    items.set(key, { key, taskId: task.id, identifier: task.identifier, title: task.title, workspaceId: task.workspaceId,
      kind, reason: reason.slice(0, 4000), source });
  };
  for (const task of tasks) {
    if (!taskHumanAccepted(task)) {
      if (task.acceptance?.blocker.trim()) add(task, "blocker", task.id, task.acceptance.blocker);
      else if (task.status === "ready" && taskAiVerified(task)) add(task, "review", task.id, "AI 已通过当前交付验收，请查看证据并确认归档。");
      else if (task.status === "done") add(task, "blocker", task.id, "历史验收记录待核对，不能直接认定 AI 或人工已通过。");
    }
    for (const slim of model.taskSessions(task)) {
      if (slim.archived || ["failed", "stopped", "exited"].includes(slim.status)) continue;
      if (++sessionReads > MAX_SESSIONS) { incompleteSources++; continue; }
      try {
        const runtime = registry?.getRuntimeSnapshot(slim.id);
        if (!runtime) {
          // A durable status cannot prove that a request is still current.
          if (slim.permissionBlocked) add(task, "permission", slim.id, "源会话有授权提示，请进入核对当前请求。", { sessionId: slim.id });
          if (slim.permissionBlocked || slim.status === "running" || slim.sessionKind === "structured" || slim.providerCliActive) incompleteSources++;
          continue;
        }
        if (runtime.id !== slim.id || runtime.archived || ["failed", "stopped", "exited"].includes(runtime.status)) continue;
        const request = runtime.pendingEscalation;
        if (!runtime.autoApprovePermissions && (request || runtime.permissionBlocked)) add(task, "permission", `${slim.id}:${request?.requestId ?? "legacy"}`,
          request?.reason || "源会话等待授权，请核对当前请求。", { sessionId: slim.id, ...(request?.requestId ? { requestId: request.requestId } : {}) });
        const messages = runtime.messages ?? [];
        const tail = messages.slice(-MAX_TURNS);
        if (tail.reduce((count, turn) => count + turn.content.length, 0) > MAX_BLOCKS) { incompleteSources++; continue; }
        // Earlier turns cannot own a current request once the latest assistant or user text is known.
        if (messages.length > MAX_TURNS && !tail.some(turn => turn.role === "assistant" || turn.role === "user" && turn.content.some(block => block.type === "text" && block.text.trim()))) incompleteSources++;
        for (const tool of pendingSessionQuestions({ ...runtime, messages: tail })) {
          const reason = sessionToolQuestions(tool).map(question => question.question).filter(Boolean).join("；");
          add(task, "question", `${slim.id}:${tool.id}`, reason || "源会话有当前待回答问题。", { sessionId: slim.id, toolId: tool.id });
        }
      } catch {
        // One unavailable owner must not turn all other known actions into an empty inbox.
        incompleteSources++;
      }
    }
  }
  for (const run of storage.listAiTeamRuns({ statuses: ["awaiting_approval", "waiting_user"] })) {
    const task = byId.get(run.taskId) ?? model.cardsByContainer.get(run.taskId);
    if (!task || !byId.has(task.id)) continue;
    add(task, run.status === "awaiting_approval" ? "plan" : "reply", run.id,
      run.statusDetail || (run.status === "awaiting_approval" ? "计划需你明确批准后才会执行。" : "负责人正在等待你的回复。"), { runId: run.id });
  }
  // Stable order, not a fabricated wait time; polling cannot reorder equivalent items.
  const priority = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return { items: [...items.values()].sort((a, b) => priority[byId.get(a.taskId)!.priority] - priority[byId.get(b.taskId)!.priority]
    || a.identifier.localeCompare(b.identifier, "zh", { numeric: true }) || a.key.localeCompare(b.key)), incompleteSources };
}
