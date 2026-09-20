import { createHash } from "node:crypto";

import { getErrorMessage } from "./error-utils.js";
import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import { isSessionProvider } from "./session-provider.js";
import { isClosedWandTaskStatus, normalizeWandTaskAgentMode, type WandTask, type WandTaskAgent, type WandTaskTitleSource } from "./task-types.js";
import type { LayoutNode, SessionSnapshot, Workspace, WorkspaceTask } from "./types.js";
import { firstLayoutTabId } from "./layout-tree.js";

/** 未命名任务的占位名；服务端新建时写入，自动命名成功后被真实标题覆盖。 */
export const UNNAMED_WORKSPACE_TASK_NAME = "未命名任务";

/** 历史客户端（Android / 桌面）留空时回传的默认名，同样视为未命名。 */
const LEGACY_UNNAMED_TASK_NAMES = new Set(["新任务"]);

export function isUnnamedWorkspaceTaskName(name: string): boolean {
  const trimmed = name.trim();
  return !trimmed || trimmed === UNNAMED_WORKSPACE_TASK_NAME || LEGACY_UNNAMED_TASK_NAMES.has(trimmed);
}

/** Legacy title helper; prompts name sessions, not their containing task. */
export function boardTitleFromSession(session: SessionSnapshot): string {
  const title = session.title?.trim();
  if (title && !isUnnamedWorkspaceTaskName(title)) return provisionalTaskTitleFromDescription(title);
  const description = session.description?.trim();
  if (description) return provisionalTaskTitleFromDescription(description);
  for (const turn of session.messages ?? []) {
    if (turn.role !== "user") continue;
    const text = turn.content.flatMap((block) => block.type === "text" ? [block.text.trim()] : [])
      .filter(Boolean).join("\n");
    if (text) return provisionalTaskTitleFromDescription(text);
  }
  return "";
}

/**
 * 自动命名只覆盖「还没有人为名字」的任务：标题来源是 auto，或仍是占位名的历史卡片
 * （老版本把未命名任务写成了 titleSource=user）。用户在面板 / 侧栏改过名后此处为 false。
 */
export function isAutoNameableBoardTask(card: Pick<WandTask, "title" | "titleSource">): boolean {
  return card.titleSource === "auto" || isUnnamedWorkspaceTaskName(card.title);
}

/** 任务下所有会话（先按看板绑定，再看侧栏 workspace_task_id 兜底），最近的排在前面。 */
function taskNamingSessions(storage: WandStorage, card: WandTask): SessionSnapshot[] {
  const sessions = new Map<string, SessionSnapshot>();
  const add = (session: SessionSnapshot | null | undefined): void => {
    if (session && !sessions.has(session.id)) sessions.set(session.id, session);
  };
  const needsMessageFallback: string[] = [];
  const addSlim = (session: SessionSnapshot | null | undefined): void => {
    if (!session) return;
    add(session);
    // boardTitleFromSession 只在 title/description 都缺时才翻 messages 找首条用户输入。
    if (!session.title?.trim() && !session.description?.trim()) needsMessageFallback.push(session.id);
  };
  if (card.workspaceTaskId) {
    for (const session of storage.listSessionsByWorkspaceTaskSlim(card.workspaceTaskId)) addSlim(session);
  }
  for (const sessionId of storage.listWandTaskSessionIds(card.id)) addSlim(storage.getSessionSlim(sessionId));
  // 只有真的需要 messages 的那几个会话才去解析大字段。
  for (const sessionId of needsMessageFallback) {
    const full = storage.getSession(sessionId);
    if (full && (full.messages?.length ?? 0) > 0) sessions.set(sessionId, full);
  }
  return [...sessions.values()].sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

/**
 * 自动命名的输入：任务描述（去掉「项目：/ 目录：/ 分支：」同步元信息）+ 每个会话的可读摘要。
 * 为空表示这个任务还没有可命名的内容，调用方应保留占位标题。
 */
export function taskAutoNameSourceText(storage: WandStorage, card: WandTask): string {
  const parts: string[] = [];
  for (const line of card.description.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:项目|目录|分支)[：:]/.test(trimmed)) continue;
    parts.push(trimmed);
  }
  for (const session of taskNamingSessions(storage, card)) {
    const candidate = boardTitleFromSession(session);
    if (candidate) parts.push(candidate);
  }
  return parts.join("\n").slice(0, 4_000);
}

/** 输入指纹：内容没变就没必要再总结一次，也避免自动标题与模型结果来回震荡。 */
export function taskAutoNameSignature(source: string): string {
  return createHash("sha1").update(source).digest("hex");
}

function agentFromSession(session: SessionSnapshot): WandTaskAgent | null {
  if (!isSessionProvider(session.provider)) return null;
  const effort = session.thinkingEffort;
  return {
    provider: session.provider,
    model: session.selectedModel || session.structuredState?.model || "default",
    thinkingEffort: effort === "standard" || effort === "deep" || effort === "max" ? effort : "off",
    mode: normalizeWandTaskAgentMode(session.provider, session.mode),
    // 会话形态按会话自身的 sessionKind 还原，PTY 会话不会在「再指派」时被误当结构化。
    kind: (session.sessionKind ?? "pty") === "structured" ? "structured" : "pty",
  };
}

/** Identity is the task id, never its title. Same-named tasks stay independent. */
export function ensureBoardTaskForWorkspaceTask(
  storage: WandStorage,
  task: WorkspaceTask,
  workspace: Workspace,
  options: { titleSource?: WandTaskTitleSource; description?: string } = {},
): WandTask {
  const existing = storage.getWandTaskByWorkspaceTaskId(task.id);
  if (existing) return existing;
  return storage.createWandTask({
    workspaceId: workspace.kind === "global" ? null : workspace.id,
    workspaceTaskId: task.id,
    title: task.name,
    // 占位名（未命名任务 / 新任务 / 空）走自动命名；用户填过名就是 user，永不被模型覆盖。
    titleSource: options.titleSource ?? (isUnnamedWorkspaceTaskName(task.name) ? "auto" : "user"),
    description: options.description ?? "",
    status: task.status === "done" ? "done" : "todo",
    milestoneId: task.milestoneId ?? null,
  });
}

/** A board task always has a sidebar container, even before its first session. */
export function ensureWorkspaceTaskForBoardTask(storage: WandStorage, card: WandTask): WorkspaceTask {
  const existing = card.workspaceTaskId ? storage.getWorkspaceTask(card.workspaceTaskId) : null;
  if (existing) return existing;
  const workspace = card.workspaceId ? storage.getWorkspace(card.workspaceId) : storage.ensureGlobalWorkspace();
  if (!workspace) throw new Error("任务所属工作区不存在。");
  const task = storage.createWorkspaceTask({
    workspaceId: workspace.id,
    name: card.title,
    status: isClosedWandTaskStatus(card.status) ? "done" : "active",
    milestoneId: card.milestoneId,
  });
  storage.updateWandTask(card.id, { workspaceTaskId: task.id });
  return task;
}

function removeSessionTab(node: LayoutNode, sessionId: string): LayoutNode {
  if (node.type === "split") return {
    ...node,
    children: [removeSessionTab(node.children[0], sessionId), removeSessionTab(node.children[1], sessionId)],
  };
  const activeId = node.tabs[node.active]?.id;
  const tabs = node.tabs.filter((tab) => tab.kind !== "session" || tab.sessionId !== sessionId);
  const active = tabs.findIndex((tab) => tab.id === activeId);
  return { ...node, tabs, active: active >= 0 ? active : Math.min(node.active, Math.max(0, tabs.length - 1)) };
}

/** Remove stale source tabs so opening an old task cannot re-open a moved session. */
function detachSessionLayout(storage: WandStorage, task: WorkspaceTask, sessionId: string): void {
  if (!task.layout) {
    storage.saveWorkspaceTaskLayout(task.id, null);
    return;
  }
  const windows = task.layout.windows.map((window) => {
    const layout = removeSessionTab(window.layout, sessionId);
    return { ...window, layout, activeTabId: firstLayoutTabId(layout) };
  });
  storage.saveWorkspaceTaskLayout(task.id, { ...task.layout, windows });
}

/** Atomic exclusive ownership change. Never changes cwd, messages, or execution state. */
export function moveSessionToWorkspaceTask(
  storage: WandStorage,
  sessionId: string,
  taskId: string | null,
): void {
  storage.transaction(() => {
    const session = storage.getSession(sessionId);
    if (!session) throw new Error("未找到该会话。");
    const target = taskId ? storage.getWorkspaceTask(taskId) : null;
    if (taskId && !target) throw new Error("未找到目标任务。");
    const source = session.workspaceTaskId ? storage.getWorkspaceTask(session.workspaceTaskId) : null;
    if (source && source.id !== target?.id) detachSessionLayout(storage, source, sessionId);
    // Explicit task metadata is owned by storage, not by a runner checkpoint.
    storage.setSessionWorkspaceTaskId(sessionId, target?.id ?? null);
    for (const card of storage.listWandTasks()) {
      if (card.workspaceTaskId !== target?.id) storage.unbindWandTaskSession(card.id, sessionId);
    }
    if (!target) return;
    const workspace = storage.getWorkspace(target.workspaceId);
    if (!workspace) throw new Error("目标工作区不存在。");
    storage.setSessionWorkspaceId(sessionId, workspace.id);
    const card = ensureBoardTaskForWorkspaceTask(storage, target, workspace);
    const newlyBound = !storage.listWandTaskSessionIds(card.id).includes(sessionId);
    storage.bindWandTaskSession(card.id, sessionId);
    if (newlyBound && card.status === "todo") storage.updateWandTask(card.id, { status: "doing" });
  });
}

/** Reconcile legacy records by explicit ids. Unassigned sessions remain unassigned. */
export function syncSidebarTasksFromBoard(storage: WandStorage): void {
  storage.transaction(() => {
    for (const card of storage.listWandTasks()) {
      // Deleted sidebar tasks leave an archived card, not a resurrected container.
      if (!card.workspaceTaskId && card.status === "archived") continue;
      const task = ensureWorkspaceTaskForBoardTask(storage, card);
      for (const sessionId of storage.listWandTaskSessionIds(card.id)) {
        // 只需要归属两列：不要用 getSession()，那会解析十几 MB 的 messages。
        const session = storage.getSessionWorkspace(sessionId);
        if (!session) continue;
        if (session.workspaceTaskId && session.workspaceTaskId !== task.id) {
          storage.unbindWandTaskSession(card.id, sessionId);
        } else if (session.workspaceTaskId !== task.id || session.workspaceId !== task.workspaceId) {
          storage.setSessionWorkspaceTaskId(sessionId, task.id);
          storage.setSessionWorkspaceId(sessionId, task.workspaceId);
        }
      }
    }
  });
}

/** 单个任务的会话归属落到看板卡片：补卡片、按会话补 Agent、绑定会话、todo → doing。 */
function syncTaskSessionsToBoard(storage: WandStorage, task: WorkspaceTask, workspace: Workspace): void {
  storage.transaction(() => {
    let card = ensureBoardTaskForWorkspaceTask(storage, task, workspace);
    const sessions = storage.listSessionsByWorkspaceTaskSlim(task.id);
    const agent = sessions.map(agentFromSession).find((value) => value !== null);
    const bound = new Set(storage.listWandTaskSessionIds(card.id));
    const started = card.status === "todo" && sessions.some((session) => !bound.has(session.id));
    if ((!card.agent && agent) || started) {
      card = storage.updateWandTask(card.id, {
        ...(!card.agent && agent ? { agent } : {}),
        ...(started ? { status: "doing" as const } : {}),
      }) ?? card;
    }
    for (const session of sessions) storage.bindWandTaskSession(card.id, session.id);
  });
}

/**
 * 会话建立 / 移动后立刻把任务归属同步到看板卡片，卡片不必等下一次 `GET /api/wand-tasks`
 * 的全量兜底同步，也不必等某个客户端碰巧拉了看板列表。
 * 看板侧的写入失败只记日志：会话已经跑起来了，不能因为看板同步失败把创建请求打断。
 */
export function syncWorkspaceTaskToBoard(storage: WandStorage, workspaceTaskId: string | null | undefined): void {
  if (!workspaceTaskId) return;
  try {
    const task = storage.getWorkspaceTask(workspaceTaskId);
    const workspace = task ? storage.getWorkspace(task.workspaceId) : null;
    if (!task || !workspace) return;
    syncTaskSessionsToBoard(storage, task, workspace);
  } catch (error) {
    console.error(`[WandTask] Failed to sync task ${workspaceTaskId} onto the board:`, getErrorMessage(error));
  }
}

/**
 * 兜底全量同步：只处理「会话带着 workspace_task_id 但卡片上还没有绑定」的历史 / 外部写入。
 * 正常路径由 `syncWorkspaceTaskToBoard` 在会话建立时点完成。
 */
export function syncUngroupedSessionsToBoard(storage: WandStorage): void {
  syncSidebarTasksFromBoard(storage);
  for (const workspace of storage.listWorkspaces()) {
    for (const task of storage.listWorkspaceTasks(workspace.id)) syncTaskSessionsToBoard(storage, task, workspace);
  }
}

/** Status and title projection is centralized in the storage writer. */
export function syncClosedBoardTask(storage: WandStorage, task: WandTask): void {
  if (isClosedWandTaskStatus(task.status) && task.workspaceTaskId) {
    storage.updateWorkspaceTask(task.workspaceTaskId, { status: "done" });
  }
}

export function archiveBoardTask(storage: WandStorage, id: string): WandTask | null {
  return storage.updateWandTask(id, { status: "archived" });
}

/**
 * 归档侧栏任务是软删除：终端继续运行、worktree 与布局都保留，只有看板卡片进入
 * 归档文件夹、侧栏不再显示。恢复方式是看板里把卡片拖回任一列（或右键恢复）。
 */
export function archiveWorkspaceTask(storage: WandStorage, task: WorkspaceTask): WandTask | null {
  return storage.transaction(() => {
    const card = storage.getWandTaskByWorkspaceTaskId(task.id);
    // 先归档卡片，再把侧栏任务标成已完成：反向投影见到 archived 就不会降级成 done。
    if (card) storage.updateWandTask(card.id, { status: "archived" });
    storage.updateWorkspaceTask(task.id, { status: "done" });
    return card ? storage.getWandTask(card.id) : null;
  });
}

export function archiveBoardTaskForWorkspaceTask(storage: WandStorage, workspaceTaskId: string): void {
  const linked = storage.getWandTaskByWorkspaceTaskId(workspaceTaskId);
  if (linked && !isClosedWandTaskStatus(linked.status)) storage.updateWandTask(linked.id, { status: "done" });
}
