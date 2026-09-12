import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import type { WandTask } from "./task-types.js";
import type { SessionSnapshot, Workspace, WorkspaceTask } from "./types.js";

const UNNAMED_TASK_NAME = "未命名任务";

function boardDescriptionFor(task: WorkspaceTask, workspace: Workspace): string {
  const lines = [`项目：${workspace.name}`];
  const cwd = task.worktree?.path || task.cwd || workspace.cwd;
  if (cwd) lines.push(`目录：${cwd}`);
  if (task.worktree?.branch) lines.push(`分支：${task.worktree.branch}`);
  return lines.join("\n");
}

export function isUnnamedWorkspaceTaskName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === UNNAMED_TASK_NAME;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/[。．.!?！？]+$/g, "").replace(/\s+/g, " ");
}

function firstUserMessageText(session: SessionSnapshot): string {
  for (const turn of session.messages ?? []) {
    if (turn.role !== "user") continue;
    const text = turn.content
      .flatMap((block) => block.type === "text" ? [block.text.trim()] : [])
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return "";
}

/** 从未分组会话的标题 / 描述 / 首条用户消息里抽出看板标题。 */
export function boardTitleFromSession(session: SessionSnapshot): string {
  const title = session.title?.trim() ?? "";
  if (title && !isUnnamedWorkspaceTaskName(title)) {
    return provisionalTaskTitleFromDescription(title);
  }
  const description = session.description?.trim() ?? "";
  if (description) return provisionalTaskTitleFromDescription(description);
  const message = firstUserMessageText(session);
  if (message) return provisionalTaskTitleFromDescription(message);
  return "";
}

function boardDescriptionFromSession(session: SessionSnapshot): string {
  const description = session.description?.trim() ?? "";
  if (description) return description;
  const title = session.title?.trim() ?? "";
  if (title && !isUnnamedWorkspaceTaskName(title)) return title;
  return firstUserMessageText(session);
}

function pickBestSession(sessions: SessionSnapshot[]): SessionSnapshot | null {
  if (sessions.length === 0) return null;
  return sessions.find((session) => boardTitleFromSession(session)) ?? sessions[0] ?? null;
}

function isSyncedWorkspaceDescription(description: string): boolean {
  const lines = description.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => line.startsWith("项目：") || line.startsWith("目录：") || line.startsWith("分支："));
}

function bindSessions(storage: WandStorage, taskId: string, sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    try {
      storage.bindWandTaskSession(taskId, sessionId);
    } catch {
      // 会话可能已被删；跳过单条，不中断整次对账。
    }
  }
}

function findBoardTaskByTitle(
  tasks: WandTask[],
  title: string,
  workspaceId: string | null | undefined,
): WandTask | null {
  const needle = normalizeTitle(title);
  if (!needle) return null;
  const sameWorkspace = tasks.filter((task) => (task.workspaceId ?? "") === (workspaceId ?? "")
    && normalizeTitle(task.title) === needle);
  if (sameWorkspace[0]) return sameWorkspace[0];
  return tasks.find((task) => normalizeTitle(task.title) === needle) ?? null;
}

function promoteUngroupedCard(
  storage: WandStorage,
  card: WandTask,
  patch: {
    title?: string;
    description?: string;
    workspaceId?: string | null;
    workspaceTaskId?: string | null;
  },
): WandTask {
  const nextTitle = patch.title?.trim() && isUnnamedWorkspaceTaskName(card.title) ? patch.title.trim() : card.title;
  const nextDescription = patch.description?.trim() && isSyncedWorkspaceDescription(card.description)
    ? patch.description.trim()
    : card.description;
  return storage.updateWandTask(card.id, {
    title: nextTitle,
    titleSource: nextTitle !== card.title ? "auto" : card.titleSource,
    description: nextDescription,
    status: card.status === "done" ? "done" : "doing",
    workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : card.workspaceId,
    workspaceTaskId: patch.workspaceTaskId !== undefined ? patch.workspaceTaskId : card.workspaceTaskId,
  }) ?? card;
}

/** 侧栏工作任务与看板卡片对账：已关联则复用，同项目同名未关联则挂上，否则新建。 */
export function ensureBoardTaskForWorkspaceTask(
  storage: WandStorage,
  task: WorkspaceTask,
  workspace: Workspace,
): WandTask | null {
  const linked = storage.getWandTaskByWorkspaceTaskId(task.id);
  if (linked) return linked;
  // 未命名侧栏任务在会话树里并进「未分组终端」；等同步函数根据会话内容补卡片。
  if (isUnnamedWorkspaceTaskName(task.name)) return null;
  const reusable = storage.findUnlinkedWandTask(workspace.id, task.name);
  if (reusable) {
    return storage.updateWandTask(reusable.id, {
      workspaceTaskId: task.id,
      workspaceId: workspace.id,
    }) ?? reusable;
  }
  return storage.createWandTask({
    workspaceId: workspace.id,
    workspaceTaskId: task.id,
    title: task.name,
    description: boardDescriptionFor(task, workspace),
    status: task.status === "done" ? "done" : "todo",
  });
}

/**
 * 把历史未分组会话补到看板：用会话标题/首条消息当标题，绑上会话，放进「进行中」。
 * 幂等，打开看板列表时调用。
 */
export function syncUngroupedSessionsToBoard(storage: WandStorage): void {
  const boardTasks = storage.listWandTasks();
  const bound = new Set(storage.listBoundWandTaskSessionIds());

  for (const workspace of storage.listWorkspaces()) {
    for (const task of storage.listWorkspaceTasks(workspace.id)) {
      if (!isUnnamedWorkspaceTaskName(task.name)) continue;
      const sessions = storage.listSessionsByWorkspaceTask(task.id);
      const best = pickBestSession(sessions);
      const title = best ? boardTitleFromSession(best) : "";
      if (!best || !title) continue;
      const description = boardDescriptionFromSession(best);
      let card = storage.getWandTaskByWorkspaceTaskId(task.id)
        ?? findBoardTaskByTitle(boardTasks, title, workspace.id);
      if (!card) {
        card = storage.createWandTask({
          workspaceId: workspace.id,
          workspaceTaskId: task.id,
          title,
          titleSource: "auto",
          description,
          status: "doing",
        });
        boardTasks.push(card);
      } else {
        card = promoteUngroupedCard(storage, card, {
          title,
          description,
          workspaceId: workspace.id,
          workspaceTaskId: task.id,
        });
      }
      bindSessions(storage, card.id, sessions.map((session) => session.id));
      for (const session of sessions) bound.add(session.id);
    }
  }

  for (const session of storage.loadSessions()) {
    if (bound.has(session.id)) continue;
    if (session.workspaceTaskId) continue;
    const title = boardTitleFromSession(session);
    if (!title) continue;
    let card = findBoardTaskByTitle(boardTasks, title, session.workspaceId ?? null);
    if (!card) {
      card = storage.createWandTask({
        workspaceId: session.workspaceId ?? null,
        title,
        titleSource: "auto",
        description: boardDescriptionFromSession(session),
        status: "doing",
      });
      boardTasks.push(card);
    } else if (card.status !== "done") {
      card = promoteUngroupedCard(storage, card, {
        title,
        description: boardDescriptionFromSession(session),
        workspaceId: session.workspaceId ?? card.workspaceId,
      });
    }
    bindSessions(storage, card.id, [session.id]);
    bound.add(session.id);
  }
}

/** 看板归档：卡片进入已完成，并同步把关联的侧栏工作任务标成 done（不删会话）。 */
export function archiveBoardTask(storage: WandStorage, id: string): WandTask | null {
  const current = storage.getWandTask(id);
  if (!current) return null;
  const archived = storage.updateWandTask(id, { status: "done" });
  if (current.workspaceTaskId) {
    const workspaceTask = storage.getWorkspaceTask(current.workspaceTaskId);
    if (workspaceTask && workspaceTask.status !== "done") {
      storage.updateWorkspaceTask(workspaceTask.id, { status: "done" });
    }
  }
  return archived;
}

/** 侧栏工作任务完成/删除时，把对应看板卡片标成已完成。 */
export function archiveBoardTaskForWorkspaceTask(storage: WandStorage, workspaceTaskId: string): void {
  const linked = storage.getWandTaskByWorkspaceTaskId(workspaceTaskId);
  if (!linked || linked.status === "done") return;
  storage.updateWandTask(linked.id, { status: "done" });
}
