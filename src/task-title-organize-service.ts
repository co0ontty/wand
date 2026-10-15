import { callConfiguredAiText, type QuickCommitAiOptions } from "./ai-text-runner.js";
import { getErrorMessage } from "./error-utils.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { parentTaskIdFrom } from "./task-agent-parsing.js";
import type { AutoTaskTitleOptions } from "./task-title-service.js";
import {
  planTitleOrganization,
  parseTitleJudgment,
  titleJudgmentPrompt,
  type OrganizeSession,
  type OrganizeTask,
  type TitleJudge,
  type TitleJudgeInput,
} from "./task-title-organize.js";
import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";
import { isGlobalWorkspace, normalizeProjectCwd, projectCwdForSession } from "./workspace-binding.js";

import type { OrganizeByTitleResult } from "./task-organize-contract.js";
export type { OrganizeByTitleResult } from "./task-organize-contract.js";

export function titleJudgeForStorage(storage: WandStorage, options: AutoTaskTitleOptions): TitleJudge | undefined {
  const config = options.config;
  if (!config) return undefined;
  const provider = config.defaultProvider;
  const ai = resolveSystemAiContext({
    provider,
    structuredState: undefined,
    runner: undefined,
    command: provider === "qoder" ? "qodercli" : (provider || "pi"),
    selectedModel: null,
    thinkingEffort: "off",
  }, config, storage.getSystemSiliconEmployee(), options.free);
  if (ai.employeeChannelOnly && !ai.cliCandidates?.length) return undefined;
  return systemTitleJudge(ai, options.cwd || config.defaultCwd || process.cwd());
}

export function systemTitleJudge(ai: QuickCommitAiOptions, cwd: string): TitleJudge {
  return async (input: TitleJudgeInput) => {
    const request = titleJudgmentPrompt(input);
    return callConfiguredAiText(request, cwd || process.cwd(), "", {
      ...ai,
      thinkingEffort: "off",
    }, parseTitleJudgment);
  };
}

function directoryKeyForTask(storage: WandStorage, task: { workspaceId: string; cwd?: string }): string {
  const workspace = storage.getWorkspace(task.workspaceId);
  if (workspace && !isGlobalWorkspace(workspace)) return normalizeProjectCwd(workspace.cwd);
  return normalizeProjectCwd(task.cwd || workspace?.cwd || "");
}

function sessionRecord(session: SessionSnapshot, teamOwned: boolean): OrganizeSession {
  return {
    id: session.id,
    title: session.title?.trim() || "",
    directoryKey: projectCwdForSession(session),
    workspaceTaskId: session.workspaceTaskId ?? null,
    teamOwned,
    archived: session.archived === true,
  };
}

/**
 * Classify the selected tasks by title and move in-scope sessions to the task
 * whose title is the same work. Sessions of selected tasks are in scope even
 * when the sidebar selection did not tick them individually.
 */
export async function organizeSelectedByTitle(
  storage: WandStorage,
  input: { taskIds: readonly string[]; sessionIds?: readonly string[]; mode?: "auto" | "all" },
  options: { judge?: TitleJudge; refreshSession?(sessionId: string): void } = {},
): Promise<OrganizeByTitleResult> {
  const taskIds = [...new Set(input.taskIds.map((id) => id.trim()).filter(Boolean))];
  const sessionIds = [...new Set((input.sessionIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const tasks: OrganizeTask[] = [];
  const snapshots = new Map<string, { name: string; title: string; titleSource: string }>();
  let foundTasks = 0;
  let skippedTasks = 0;
  const refused: OrganizeByTitleResult["refused"] = [];
  for (const id of taskIds) {
    const task = storage.getWorkspaceTask(id);
    const card = task ? storage.getWandTaskByWorkspaceTaskId(task.id) : null;
    if (!task || !card) {
      refused.push({ id, kind: "task", reason: "未找到该任务" });
      continue;
    }
    foundTasks++;
    if ((input.mode ?? "auto") === "auto" && card.titleSource !== "auto") {
      skippedTasks++;
      continue;
    }
    snapshots.set(task.id, { name: task.name, title: card.title, titleSource: card.titleSource });
    tasks.push({
      id: task.id,
      cardId: card.id,
      titles: [task.name, card.title],
      workspaceId: card.workspaceId,
      directoryKey: directoryKeyForTask(storage, task),
      status: card.status,
      parentTaskId: card.parentTaskId,
      createdAt: task.createdAt,
      archived: card.status === "archived" || task.archived === true,
    });
  }
  if (!tasks.length) {
    return { ok: true, foundTasks, eligibleTasks: 0, skippedTasks, movedSessions: [], categorizedTasks: [], refused };
  }
  const teamIds = new Set([
    ...storage.listAiTeamRunChatMarkers().keys(),
    ...storage.listAiTeamStepSessionMarkers().keys(),
  ]);
  const sessions = new Map<string, OrganizeSession>();
  for (const task of tasks) {
    for (const session of storage.listSessionsByWorkspaceTaskSlim(task.id)) {
      sessions.set(session.id, sessionRecord(session, teamIds.has(session.id)));
    }
  }
  for (const id of sessionIds) {
    if (sessions.has(id)) continue;
    const session = storage.getSessionSlim(id);
    if (!session) {
      refused.push({ id, kind: "session", reason: "未找到该会话" });
      continue;
    }
    // Explicit session selection must not pull user-named tasks into auto mode.
    if ((input.mode ?? "auto") === "auto" && session.workspaceTaskId
      && storage.getWandTaskByWorkspaceTaskId(session.workspaceTaskId)?.titleSource !== "auto") continue;
    sessions.set(session.id, sessionRecord(session, teamIds.has(session.id)));
  }
  const plan = await planTitleOrganization(tasks, [...sessions.values()], options.judge);
  refused.push(...plan.refused);
  // A semantic judgment is asynchronous: manual renames during it invalidate the pass.
  if (tasks.some((task) => {
    const current = storage.getWorkspaceTask(task.id);
    const card = storage.getWandTask(task.cardId);
    const before = snapshots.get(task.id)!;
    return !current || !card || current.name !== before.name || card.title !== before.title
      || card.titleSource !== before.titleSource || card.status !== task.status
      || card.parentTaskId !== task.parentTaskId || card.workspaceId !== task.workspaceId;
  })) {
    refused.push({ id: "changed", kind: "task", reason: "任务在归类期间已改变，请重新归类" });
    return { ok: true, foundTasks, eligibleTasks: tasks.length, skippedTasks, movedSessions: [], categorizedTasks: [], refused };
  }
  const movedSessions: OrganizeByTitleResult["movedSessions"] = [];
  for (const move of plan.sessionMoves) {
    const before = sessions.get(move.sessionId);
    const current = storage.getSessionSlim(move.sessionId);
    if (!before || !current || current.archived || (current.workspaceTaskId ?? null) !== before.workspaceTaskId
      || (current.title?.trim() || "") !== before.title || projectCwdForSession(current) !== before.directoryKey
      || ((input.mode ?? "auto") === "auto" && current.workspaceTaskId
        && storage.getWandTaskByWorkspaceTaskId(current.workspaceTaskId)?.titleSource !== "auto")) {
      refused.push({ id: move.sessionId, kind: "session", reason: "会话在归类期间已改变，未改归属" });
      continue;
    }
    const task = storage.getWorkspaceTask(move.taskId);
    try {
      storage.moveSessionToWorkspaceTask(move.sessionId, move.taskId);
      options.refreshSession?.(move.sessionId);
      movedSessions.push({ sessionId: move.sessionId, taskId: move.taskId, taskName: task?.name ?? "" });
    } catch (error) {
      refused.push({ id: move.sessionId, kind: "session", reason: getErrorMessage(error, "无法移动会话") });
    }
  }
  const categorizedTasks: OrganizeByTitleResult["categorizedTasks"] = [];
  for (const link of plan.taskParents) {
    const task = tasks.find((item) => item.id === link.workspaceTaskId);
    const card = task ? storage.getWandTask(task.cardId) : null;
    const parent = storage.getWandTask(link.parentCardId);
    if (!task || !card || !parent) {
      refused.push({ id: link.workspaceTaskId, kind: "task", reason: "未找到要归入的任务" });
      continue;
    }
    try {
      const parentTaskId = parentTaskIdFrom(storage, link.parentCardId, card.workspaceId, card.id, card.parentTaskId);
      storage.updateWandTask(card.id, { parentTaskId });
      categorizedTasks.push({ taskId: task.id, parentTaskId: parent.id, parentTitle: parent.title });
    } catch (error) {
      refused.push({ id: task.id, kind: "task", reason: getErrorMessage(error, "无法归类任务") });
    }
  }
  return { ok: true, foundTasks, eligibleTasks: tasks.length, skippedTasks, movedSessions, categorizedTasks, refused };
}
