import { createHash } from "node:crypto";
import type { WandStorage } from "./storage.js";
import type { SessionSnapshot } from "./types.js";
import type { ConversationOrganizationDependencies } from "./conversation-organize-service.js";
import type { ConversationOrganizationJob, OrganizationChoice } from "./conversation-organize-contract.js";
import { conversationContent } from "./conversation-organize.js";
import { isArchiveBlocked } from "./archive-policy.js";

export function organizationArchiveBlocked(session: SessionSnapshot): boolean {
  const turns = session.messages ?? [];
  return isArchiveBlocked(session) || session.status === "failed" || !!session.structuredState?.lastError
    || turns.at(-1)?.role === "user" || turns.some(turn => turn.external?.state === "unknown" || turn.external?.state === "sending")
    || !conversationContent(session).text;
}
export function organizationRevision(session: SessionSnapshot): string {
  return createHash("sha256").update(JSON.stringify({ content: conversationContent(session), status: session.status,
    end: session.endedAt, directory: session.cwd, busy: isArchiveBlocked(session) })).digest("hex");
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function refresh(deps: ConversationOrganizationDependencies, ids: string[]): void {
  for (const id of ids) { deps.refreshSession?.(id); deps.refreshArchive?.(id); }
}

/** Plan, membership, archive flags and receipt are committed together; no runner is stopped. */
export function applyOrganizationReview(storage: WandStorage, deps: ConversationOrganizationDependencies,
  original: ConversationOrganizationJob, choices: OrganizationChoice[]): ConversationOrganizationJob {
  if (!Array.isArray(choices) || !choices.length || choices.length > 500) throw new Error("请选择要整理的会话。");
  const key = digest(choices);
  if (original.review?.state === "applied" && original.review.appliedKey === key) return original;
  if (original.status !== "completed" || original.review?.state !== "prepared") throw new Error("本次建议不可提交，请查询整理结果。");
  const job = structuredClone(original), review = job.review!;
  const seen = new Set<string>();
  const get = (id: string) => deps.getSession?.(id) ?? storage.getSession(id);
  storage.transaction(() => {
    review.receipt = []; review.createdTaskIds = [];
    const createdByTitle = new Map<string, string>();
    const checkedTargets = new Set<string>();
    for (const choice of choices) {
      const suggestion = review.suggestions.find(item => item.id === choice?.id);
      if (!suggestion || !Array.isArray(choice.sessionIds) || !choice.sessionIds.length
        || typeof choice.title !== "string" || !choice.title.trim() || choice.title.trim().length > 40
        || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(choice.title)
        || choice.existingTaskId !== null && typeof choice.existingTaskId !== "string") throw new Error("整理选项无效，请检查任务名称和会话选择。");
      const members = choice.sessionIds.map(id => {
        const before = review.sessions.find(item => item.id === id), current = get(id);
        if (seen.has(id) || !suggestion.sessionIds.includes(id) || !before || !current) throw new Error("会话重复或已不存在，请重新分析。");
        seen.add(id);
        if (current.workspaceTaskId || current.archived || (current.workspaceId ?? null) !== before.workspaceId
          || organizationRevision(current) !== before.revision || isArchiveBlocked(current) || suggestion.action === "archive" && organizationArchiveBlocked(current)) throw new Error(`「${before.title}」已有新进展、归属变化或仍在执行，请重新分析。`);
        return { before, current };
      });
      if (suggestion.action === "keep" && !choice.existingTaskId) throw new Error("待确认会话请明确选择已有任务，或保留未分组。");
      let taskId = choice.existingTaskId;
      if (taskId) {
        const expected = review.targets.find(target => target.id === taskId), card = storage.getWandTaskByWorkspaceTaskId(taskId);
        if (!expected || !card || !checkedTargets.has(taskId) && card.updatedAt !== expected.revision || card.status === "archived" && suggestion.action !== "archive") throw new Error("目标任务已变化或不在当前目录，请重新分析。");
        checkedTargets.add(taskId);
      } else {
        const title = choice.title.trim(), creationKey = `${suggestion.action}:${title}`;
        taskId = createdByTitle.get(creationKey) ?? null;
        if (!taskId) {
          const source = members[0]!.before;
          const container = storage.createWorkspaceTask({ workspaceId: source.targetWorkspaceId ?? storage.ensureGlobalWorkspace().id,
            name: title, cwd: source.directory, board: { titleSource: "user", description: suggestion.action === "archive"
              ? "历史零散会话收纳。归档仅表示收纳，不代表工作完成或验收通过。" : suggestion.reason } });
          taskId = container.id; createdByTitle.set(creationKey, taskId); review.createdTaskIds.push(taskId);
          if (suggestion.action === "archive") storage.updateWandTask(storage.getWandTaskByWorkspaceTaskId(taskId)!.id, { status: "archived" });
        }
      }
      for (const { before, current } of members) {
        storage.moveSessionToWorkspaceTask(current.id, taskId, true, suggestion.action === "archive");
        const archived = suggestion.action === "archive";
        if (archived) storage.setOrganizedSessionArchive(current.id, true);
        review.receipt.push({ sessionId: current.id, taskId, workspaceId: before.workspaceId, archived, revision: before.revision });
      }
    }
    review.createdTaskRevisions = Object.fromEntries(review.createdTaskIds.map(id => [id, digest({ card: storage.getWandTaskByWorkspaceTaskId(id), container: storage.getWorkspaceTask(id) })]));
    review.appliedKey = key; review.state = "applied";
    job.stage = "整理已保存；未派发执行，也未改变已有任务的工作流状态。";
    storage.saveConversationOrganizationJob(job);
  });
  refresh(deps, [...seen]);
  return job;
}

export function undoOrganizationReview(storage: WandStorage, deps: ConversationOrganizationDependencies,
  original: ConversationOrganizationJob): ConversationOrganizationJob {
  if (original.review?.state === "undone") return original;
  if (original.review?.state !== "applied") throw new Error("本次整理尚未保存，无法撤销。");
  const job = structuredClone(original), review = job.review!;
  storage.transaction(() => {
    // All-or-nothing undo. Never overwrite work that happened after organization.
    for (const item of review.receipt ?? []) {
      const current = deps.getSession?.(item.sessionId) ?? storage.getSession(item.sessionId);
      if (!current || current.workspaceTaskId !== item.taskId || !!current.archived !== item.archived
        || organizationRevision(current) !== item.revision || isArchiveBlocked(current)
        || storage.taskHasUnsettledDispatch(storage.getWandTaskByWorkspaceTaskId(item.taskId)!.id))
        throw new Error("整理后的会话已有新进展或任务派发，未撤销任何内容；请手动调整归属。");
    }
    for (const item of review.receipt ?? []) {
      storage.moveSessionToWorkspaceTask(item.sessionId, null, true);
      storage.setOrganizedSessionArchive(item.sessionId, false, item.workspaceId);
    }
    let retained = 0;
    for (const id of review.createdTaskIds ?? []) {
      const card = storage.getWandTaskByWorkspaceTaskId(id);
      if (!card) continue;
      const untouched = review.createdTaskRevisions?.[id] === digest({ card, container: storage.getWorkspaceTask(id) });
      if (untouched && !storage.listSessionsByWorkspaceTaskSlim(id).length
        && !storage.listWandTaskCommentsPage(card.id, { limit: 1 }).totalCount
        && !storage.listWandTasks().some(task => task.parentTaskId === card.id)) storage.deleteWandTask(card.id);
      else retained++;
    }
    review.state = "undone"; job.stage = `已恢复原会话归属与归档状态。${retained ? `${retained} 个新建任务已有后续修改，予以保留。` : "本次新建且未被修改的空任务已移除。"}`;
    storage.saveConversationOrganizationJob(job);
  });
  refresh(deps, (review.receipt ?? []).map(item => item.sessionId));
  return job;
}
