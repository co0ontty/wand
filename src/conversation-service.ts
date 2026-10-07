import { createHash, randomUUID } from "node:crypto";
import { statSync, rmSync, existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { AI_TEAM_ACTIVE_RUN_STATUSES, AI_TEAM_DEFAULT_MAX_STEPS, AI_TEAM_MAX_MEMBERS,
  memberAgents, type AiTeam, type AiTeamMember, type AiTeamRun } from "./ai-team-types.js";
import { freezeTeamEmployees, projectTeamEmployees, requireTeamEmployee } from "./ai-team-employee-binding.js";
import { AiTeamConflictError, type AiTeamRunner } from "./ai-team-runner.js";
import { CONVERSATION_OWNER, CONVERSATION_RELAY_PREFIX, employeeConversationId,
  type ConversationDetail, type ConversationInstance, type ConversationReceipt, type ConversationSummary,
  type ConversationTarget, type ConversationSessionUpdate } from "./conversation-types.js";
import { conversationLeaderMention, conversationMessageBody } from "./conversation-mentions.js";
import { getDefaultModelForProvider } from "./config.js";
import { defaultModelGroupSelector } from "./model-groups.js";
import { getErrorMessage } from "./error-utils.js";
import { resolveSessionCwd } from "./session-cwd.js";
import { resolveWorkspaceIdForNewSession } from "./workspace-binding.js";
import { CONVERSATION_SESSION_PREFIX, conversationSessionPreview } from "./conversation-session-preview.js";
import { conversationTaskLiveText } from "./conversation-task-preview.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { userAuthor, userDisplayName } from "./user-profile.js";
import type { WandStorage } from "./storage.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import { cleanupWorktreeSync } from "./git-worktree.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import type { ConversationAuthor, ConversationTurn, ProcessEvent, SessionSnapshot, WandConfig } from "./types.js";

export interface GroupInput {
  employeeIds?: string[];
  templateId?: string;
  excludedMemberIds?: string[];
  leaderId?: string;
  name?: string;
  duties?: Record<string, string>;
}

interface ConversationDispatchInput {
  title?: string;
  description: string;
  workspaceId?: string;
  cwd?: string;
  memberVersion?: number;
  continueTaskId?: string;
}

const now = (): string => new Date().toISOString();
const keyOf = (member: AiTeamMember): string => member.employeeId ??
  `${member.legacyTemplateId ?? "legacy"}:${member.legacyMemberId ?? member.id}`;
function shortText(value: unknown, label: string, max: number, required = false): string {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label}必须是文字。`);
  const text = (value as string | undefined)?.trim() ?? "";
  if (text.length > max || (required && !text)) throw new Error(`${label}${required ? "不能为空且" : ""}不能超过 ${max} 个字符。`);
  return text;
}
function ids(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) throw new Error("成员 ID 列表无效。");
  if (new Set(value).size !== value.length) throw new Error("同一员工不能重复选择。");
  return value as string[];
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Business coordination only; all execution remains in StructuredSessionManager / AiTeamRunner. */
export class ConversationService {
  constructor(private readonly deps: {
    storage: WandStorage;
    structured: Pick<StructuredSessionManager, "createSession" | "createRelaySession" | "get" | "sendMessage" | "appendRelayTurns">;
    runner: AiTeamRunner;
    config: WandConfig;
    deleteSession?(id: string): void;
    notifySession?(update: ConversationSessionUpdate): void;
  }) {}

  private readonly removals = new Map<string, Promise<void>>();
  private readonly pendingOperations = new Map<string, Set<Promise<unknown>>>();
  private readonly previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Reuse session events; send only a bounded IM projection, never a second execution protocol. */
  ingestSessionEvent(event: ProcessEvent): void {
    const session = this.deps.structured.get(event.sessionId);
    if (!this.deps.notifySession || !session?.automationId?.startsWith(CONVERSATION_SESSION_PREFIX)
      || this.previewTimers.has(event.sessionId)) return;
    const timer = setTimeout(() => {
      this.previewTimers.delete(event.sessionId);
      const current = this.snapshot(event.sessionId);
      const requestId = current?.automationId?.slice(CONVERSATION_SESSION_PREFIX.length);
      const receipt = requestId ? this.receipt(requestId) : null;
      if (!receipt || receipt.sessionId !== event.sessionId || !this.storage.getConversation(receipt.conversationId)
        || this.storage.conversationListState(receipt.conversationId).deleting) return;
      this.deps.notifySession?.({ conversationId: receipt.conversationId, sessionId: event.sessionId,
        preview: conversationSessionPreview(current, receipt) });
    }, 100);
    timer.unref?.(); this.previewTimers.set(event.sessionId, timer);
  }

  dispose(): void {
    for (const timer of this.previewTimers.values()) clearTimeout(timer);
    this.previewTimers.clear();
  }

  private get storage(): WandStorage { return this.deps.storage; }
  private snapshot(id: string | null): SessionSnapshot | null {
    return id ? this.deps.structured.get(id) ?? this.storage.getSession(id) : null;
  }

  /** Explicit startup/event migration, never a GET repair and never an invented group. */
  importRun(run: AiTeamRun): void {
    if (!run.chatSessionId || run.conversationId) return;
    let group = this.storage.getConversationBySession(run.chatSessionId);
    if (!group) {
      const team = JSON.parse(JSON.stringify(run.team)) as AiTeam;
      for (const member of team.members) {
        if (!member.employeeId) { member.legacyTemplateId = run.teamId; member.legacyMemberId = member.id; }
      }
      group = {
        id: `group_${run.chatSessionId}`, owner: CONVERSATION_OWNER, kind: "group", peerEmployeeId: null,
        name: team.name, nameSource: "auto", sourceTemplateId: run.teamId, team,
        memberVersion: 1, joinedVersions: Object.fromEntries(team.members.map((m) => [keyOf(m), 1])),
        sessionId: run.chatSessionId, communicationSessionId: null, createdAt: run.createdAt, updatedAt: run.updatedAt,
      };
    }
    this.storage.transaction(() => {
      this.storage.saveConversation(group!);
      if (this.storage.getWandTask(run.taskId)) this.storage.linkConversationTask(group!.id, run.taskId, run.createdAt);
      // Only additive identity metadata; preserve team, messages, timestamps and ownership.
      this.storage.saveAiTeamRun({ ...run, conversationId: group!.id, memberVersion: group!.memberVersion,
        roundNumber: this.storage.listAiTeamRuns({ taskId: run.taskId }).filter((r) => r.createdAt <= run.createdAt).length });
    });
  }

  migrateExistingChats(): void {
    for (const run of this.storage.listAiTeamRuns().reverse()) this.importRun(run);
  }

  pendingEmployee(employeeId: string): ConversationInstance {
    const employee = this.storage.getSiliconEmployee(employeeId);
    return { id: employeeConversationId(employeeId), owner: CONVERSATION_OWNER, kind: "dm", peerEmployeeId: employeeId,
      name: employee?.name ?? "原对话暂不可用", nameSource: "auto", sourceTemplateId: null, team: null,
      memberVersion: 1, joinedVersions: {}, sessionId: null, communicationSessionId: null, createdAt: "", updatedAt: "" };
  }

  private requireInstance(id: string): ConversationInstance {
    const found = this.storage.getConversation(id);
    if (found) return found;
    if (id.startsWith("dm_e_")) return this.pendingEmployee(id.slice(3));
    throw new Error("对话不存在。");
  }

  /** 会话里「我自己」的署名与头像：跟随当前设置，改设置不改写历史回合。 */
  private selfAuthor(): ConversationAuthor {
    return userAuthor(this.deps.config.userProfile);
  }

  private selfName(): string {
    return userDisplayName(this.deps.config.userProfile);
  }

  private memberReasons(instance: ConversationInstance): Record<string, string> {
    const reasons: Record<string, string> = {};
    for (const member of instance.team?.members ?? []) {
      if (!member.employeeId) continue;
      try { requireTeamEmployee(this.storage, member.employeeId); }
      catch (error) { reasons[member.id] = getErrorMessage(error); }
    }
    return reasons;
  }

  private turns(instance: ConversationInstance): ConversationTurn[] {
    const relay = this.snapshot(instance.sessionId)?.messages ?? [];
    const channelIds = [...(instance.historySessionIds ?? []), instance.communicationSessionId]
      .filter((id): id is string => !!id && (instance.kind === "dm" || id !== instance.sessionId));
    const communication = [...new Set(channelIds)].flatMap((id) => {
      const channel = this.snapshot(id);
      return (channel?.messages ?? []).filter((turn) => turn.role === "assistant").map((turn, index) => ({
        ...turn, messageId: turn.messageId ?? `${id}:${index}`, conversationId: instance.id, conversationTarget: null,
        ...(turn.role === "assistant" && !turn.author ? { author: {
          id: channel?.employeeId ?? instance.team?.members.find((m) => m.isLeader)?.id ?? "leader",
          name: channel?.employeeName ?? instance.team?.members.find((m) => m.isLeader)?.name ?? instance.name,
          avatar: channel?.employeeAvatar, sessionId: id,
          leader: instance.kind === "group" || undefined,
        } } : {}),
      }));
    });
    const base = instance.kind === "dm" ? [] : relay.map((turn, index) => ({ ...turn,
      messageId: turn.messageId ?? `${instance.sessionId}:${index}`, conversationId: instance.id }));
    // 用户发言的署名是当前资料的投影，不回写存储：改设置后历史消息跟着换名字。
    const withSelf = (turn: ConversationTurn): ConversationTurn =>
      turn.role === "user" && !turn.author ? { ...turn, author: this.selfAuthor() } : turn;
    return [...base, ...this.storage.conversationEvents(instance.id), ...communication].map(withSelf)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || (instance.kind === "dm" ? 0 : (a.role === "user" ? -1 : 0) - (b.role === "user" ? -1 : 0)));
  }

  summary(instance: ConversationInstance): ConversationSummary {
    const tasks = this.storage.conversationTasks(instance.id).flatMap((link) => {
      const task = this.storage.getWandTask(link.taskId);
      const receipt = task ? this.storage.conversationTaskStartup(task.id) : null;
      return task ? [{ task, linkedAt: link.linkedAt,
        runs: this.storage.listAiTeamRuns({ taskId: task.id }).filter((run) => run.conversationId === instance.id || (!!instance.sessionId && run.chatSessionId === instance.sessionId)),
        ...(receipt?.startup ? { startup: { state: receipt.startup, error: receipt.error } } : {}) }] : [];
    });
    const employee = instance.peerEmployeeId ? this.storage.getSiliconEmployee(instance.peerEmployeeId) : null;
    const lifecycle = this.storage.conversationListState(instance.id);
    let unavailableReason: string | null = lifecycle.deleting ? "对话正在删除，请稍后重试。" : lifecycle.dissolvedAt ? "群聊已解散，恢复后可以继续聊天。" : null;
    if (instance.kind === "dm") {
      try { requireTeamEmployee(this.storage, instance.peerEmployeeId ?? ""); }
      catch (error) { unavailableReason = getErrorMessage(error); }
    }
    const messages = this.turns(instance);
    const last = messages.at(-1);
    const lastText = last?.sessionLink ? conversationSessionPreview(this.snapshot(last.sessionLink.sessionId), last.requestId ? this.receipt(last.requestId) ?? undefined : undefined).text
      : last?.content.map((b) => b.type === "text" ? b.text : "").join(" ") ?? "";
    const messageAt = [instance.updatedAt, last?.createdAt ?? "", ...tasks.flatMap((t) => t.runs.map((r) => r.updatedAt))].sort().at(-1) ?? "";
    const title = instance.kind === "dm" ? employee?.name ?? instance.name
      : instance.nameSource === "custom" ? instance.name : tasks.at(-1)?.task.title ?? instance.name;
    return { ...instance, ...this.storage.conversationListState(instance.id), team: instance.team ? projectTeamEmployees(instance.team, this.storage) : null,
      title, unavailableReason, memberUnavailableReasons: this.memberReasons(instance), tasks,
      preview: last ? `${last.role === "user" ? this.selfName() : last.author?.name ?? "系统"}：${lastText.slice(0, 160)}`
        : instance.kind === "group" ? "群已建立，尚未派任务" : "还没有消息", messageAt };
  }

  list(): ConversationSummary[] {
    return this.storage.listConversations().map((instance) => this.summary(instance))
      .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") || b.messageAt.localeCompare(a.messageAt) || a.id.localeCompare(b.id));
  }

  updateListState(id: string, patch: { pinned?: boolean; dissolved?: boolean }): ConversationSummary {
    const instance = this.requireInstance(id);
    if (!this.storage.getConversation(id)) throw new Error("对话尚未创建。");
    if (this.storage.conversationListState(id).deleting) throw new AiTeamConflictError("对话正在删除。");
    if (patch.dissolved !== undefined && instance.kind !== "group") throw new Error("只有群聊可以解散或恢复。");
    this.storage.updateConversationListState(id, { ...patch, dissolvedBy: this.selfName() });
    return this.summary(instance);
  }

  /** Delete only this conversation's owned channels and, for groups, its linked task resources. */
  remove(id: string): Promise<void> {
    const previous = this.removals.get(id);
    if (previous) return previous;
    const removal = this.removeOwnedResources(id);
    this.removals.set(id, removal);
    void removal.finally(() => { if (this.removals.get(id) === removal) this.removals.delete(id); }).catch(() => {});
    return removal;
  }

  private async removeOwnedResources(id: string): Promise<void> {
    let instance = this.storage.getConversation(id);
    if (!instance) return;
    if (!this.deps.deleteSession) throw new Error("当前服务未启用会话删除。");
    this.storage.updateConversationListState(id, { deleting: true });
    await Promise.allSettled([...(this.pendingOperations.get(id) ?? [])]);
    // Pending prepare/send operations may have attached a channel while deletion waited.
    instance = this.storage.getConversation(id);
    if (!instance) return;
    const taskIds = instance.kind === "group" ? this.storage.conversationTasks(id).map(link => link.taskId) : [];
    const runs = taskIds.flatMap(taskId => this.storage.listAiTeamRuns({ taskId }));
    const sessionIds = new Set([instance.sessionId, instance.communicationSessionId, ...(instance.historySessionIds ?? []),
      ...this.storage.conversationSessionIds(id),
      ...taskIds.flatMap(taskId => this.storage.listWandTaskSessionIds(taskId)),
      ...runs.flatMap(run => [run.chatSessionId, ...this.storage.listAiTeamSteps(run.id).map(step => step.sessionId)])].filter((value): value is string => !!value));
    const worktrees = taskIds.flatMap(taskId => {
      const task = this.storage.getWandTask(taskId);
      const tree = task?.workspaceTaskId ? this.storage.getWorkspaceTask(task.workspaceTaskId)?.worktree : null;
      return tree ? [tree] : [];
    });
    for (const tree of worktrees) {
      if (this.storage.loadSessionsSlim().some(session => !sessionIds.has(session.id) && (resolve(session.cwd) === resolve(tree.path) || resolve(session.cwd).startsWith(resolve(tree.path) + sep)))) {
        this.storage.updateConversationListState(id, { deleting: false });
        throw new AiTeamConflictError("关联工作目录仍被其他会话使用，请先移出这些会话。");
      }
    }
    for (const run of runs) {
      if (AI_TEAM_ACTIVE_RUN_STATUSES.includes(this.storage.getAiTeamRun(run.id)?.status ?? "done")) await this.deps.runner.stop(run.id);
    }
    // A queued startup may have completed while stop waited on the run's serial owner.
    for (const run of runs) for (const step of this.storage.listAiTeamSteps(run.id)) if (step.sessionId) sessionIds.add(step.sessionId);
    for (const taskId of taskIds) for (const sessionId of this.storage.listWandTaskSessionIds(taskId)) sessionIds.add(sessionId);
    for (const sessionId of sessionIds) this.deps.deleteSession(sessionId);
    for (const run of runs) {
      // Exact run-owned directory only; never follow a replaced report-root symlink.
      if (!/^run_[a-zA-Z0-9_-]+$/.test(run.id)) throw new Error("运行资源路径无效。");
      const root = resolve(run.cwd, ".wand-team"), directory = resolve(root, run.id);
      if (existsSync(directory)) {
        if (!realpathSync(directory).startsWith(realpathSync(run.cwd) + sep) || realpathSync(root) !== resolve(realpathSync(run.cwd), ".wand-team") || realpathSync(directory) !== resolve(realpathSync(root), run.id)) throw new Error("运行资源目录已改变，请核对后重试删除。");
        rmSync(directory, { recursive: true, force: true });
      }
      this.storage.deleteAiTeamRun(run.id);
    }
    for (const tree of worktrees) cleanupWorktreeSync(tree);
    for (const taskId of taskIds) this.storage.deleteWandTask(taskId);
    this.storage.deleteConversation(id);
  }

  history(id: string): ConversationTurn[] { return this.turns(this.requireInstance(id)); }

  detail(id: string): ConversationDetail {
    const instance = this.requireInstance(id);
    const summary = this.summary(instance);
    return { ...summary, messages: this.turns(instance).map(turn => turn.sessionLink
      ? { ...turn, sessionPreview: conversationSessionPreview(this.snapshot(turn.sessionLink.sessionId), turn.requestId ? this.receipt(turn.requestId) ?? undefined : undefined),
        // Older clients can still open the exact source session without understanding sessionLink.
        author: turn.author ? { ...turn.author, sessionId: turn.sessionLink.sessionId } : turn.author,
        content: turn.content.length ? turn.content : [{ type: "text" as const, text: "消息已接收，打开对应会话查看实时回复。" }] }
      : this.taskPreview(turn)),
      runDetails: summary.tasks.flatMap((task) => task.runs.map((run) => this.deps.runner.detail(run.id))) };
  }

  /** Read-only, bounded projection of the exact accepted run. Never follow a group's newest task. */
  private taskPreview(turn: ConversationTurn): ConversationTurn {
    const link = turn.conversationLink;
    if (!link) return turn;
    const group = this.storage.getConversation(link.conversationId);
    const task = this.storage.getWandTask(link.taskId);
    if (!group || !task || this.storage.conversationListState(group.id).deleting
      || !this.storage.conversationTasks(group.id).some(item => item.taskId === task.id)) {
      return { ...turn, taskPreview: { runId: null, status: "unavailable", text: "任务群或任务已删除，原消息保留。" } };
    }
    const receipt = turn.requestId ? this.receipt(turn.requestId) : null;
    const run = receipt?.runId ? this.storage.getAiTeamRun(receipt.runId) : null;
    const exact = run?.taskId === task.id && run.conversationId === group.id ? run : null;
    const status = receipt?.startup === "failed" ? "failed" : exact?.status ?? "starting";
    const live = exact?.status === "running" ? conversationTaskLiveText(this.deps.runner.live(exact.id)) : "";
    const latest = exact ? this.snapshot(group.sessionId)?.messages?.slice().reverse().find(message =>
      message.role === "assistant" && message.conversationTarget?.runId === exact.id
      && message.content.some(block => block.type === "text" && block.text.trim())) : null;
    const text = (receipt?.startup === "failed" ? receipt.error : live)
      || latest?.content.map(block => block.type === "text" ? block.text : "").join("\n")
      || exact?.statusDetail || "任务已接收，正在启动；无需重复发送。";
    return { ...turn, conversationLink: { ...link, title: task.title },
      taskPreview: { runId: exact?.id ?? null, status, text: text.slice(-4000) } };
  }

  private groupTeam(input: GroupInput, groupId: string): { team: AiTeam; sourceTemplateId: string | null } {
    const templateId = shortText(input.templateId, "预设 ID", 100);
    const template = templateId ? this.storage.getAiTeam(templateId) : null;
    if (templateId && !template) throw new Error("预设小组不存在。");
    const excluded = new Set(ids(input.excludedMemberIds));
    if ([...excluded].some((id) => !template?.members.some((m) => m.id === id))) throw new Error("移除的预设成员不存在。");
    const members: AiTeamMember[] = (template?.members ?? []).filter((m) => !excluded.has(m.id)).map((m) => ({
      ...m, agents: memberAgents(m).map((a) => ({ ...a })),
      ...(!m.employeeId ? { legacyTemplateId: template!.id, legacyMemberId: m.id } : {}),
    }));
    for (const id of ids(input.employeeIds)) {
      if (members.some((m) => m.employeeId === id)) continue;
      const employee = requireTeamEmployee(this.storage, id);
      members.push({ id: `m_${randomUUID().replace(/-/g, "").slice(0, 8)}`, employeeId: id, name: employee.name,
        duty: employee.duty, avatar: employee.avatar, agents: employee.agents.map((a) => ({ ...a })),
        agent: employee.agents[0]!, isLeader: members.length === 0 });
    }
    if (members.length < 1 || members.length > AI_TEAM_MAX_MEMBERS) throw new Error(`群聊需要 1–${AI_TEAM_MAX_MEMBERS} 位员工。`);
    const leaderId = shortText(input.leaderId, "负责人", 100);
    if (leaderId) {
      if (!members.some((m) => m.id === leaderId || m.employeeId === leaderId)) throw new Error("负责人必须是本群成员。");
      members.forEach((m) => { m.isLeader = m.id === leaderId || m.employeeId === leaderId; });
    }
    if (members.filter((m) => m.isLeader).length !== 1) throw new Error("请选择恰好一位负责人。");
    for (const member of members) {
      if (member.employeeId) requireTeamEmployee(this.storage, member.employeeId);
      if (input.duties?.[member.employeeId ?? member.id] !== undefined) {
        member.duty = shortText(input.duties[member.employeeId ?? member.id], "群内职责", 2000);
      }
    }
    const createdAt = now();
    return { team: { id: groupId, name: template?.name ?? "群聊", description: template?.description ?? "",
      instructions: template?.instructions ?? "", members, requirePlanApproval: template?.requirePlanApproval ?? true,
      maxSteps: template?.maxSteps ?? AI_TEAM_DEFAULT_MAX_STEPS, createdAt, updatedAt: createdAt }, sourceTemplateId: template?.id ?? null };
  }

  /** `autoName` 是自动群的首轮任务标题：保持 auto 命名，名字继续跟随最新任务。 */
  private newGroup(input: GroupInput, autoName = ""): ConversationInstance {
    const id = `group_${randomUUID()}`;
    const { team, sourceTemplateId } = this.groupTeam(input, id);
    const leader = team.members.find((m) => m.isLeader)!;
    const name = shortText(input.name, "群名", 120);
    return { id, owner: CONVERSATION_OWNER, kind: "group", peerEmployeeId: null,
      name: name || shortText(autoName, "任务标题", 200).slice(0, 120)
        || (sourceTemplateId ? team.name : team.members.length === 1 ? `我与${leader.name}的群聊` : `${leader.name}等的群聊`),
      nameSource: name ? "custom" : "auto", sourceTemplateId, team, memberVersion: 1,
      joinedVersions: Object.fromEntries(team.members.map((m) => [keyOf(m), 1])),
      sessionId: null, communicationSessionId: null, createdAt: now(), updatedAt: now() };
  }

  private request(requestId: string, kind: string, input: unknown, id: string,
    operation: (receipt: ConversationReceipt, commit: () => void) => Promise<void> | void): Promise<ConversationReceipt> {
    const state = this.storage.conversationListState(id);
    if (state.deleting || state.dissolvedAt) operation = () => { throw new Error(state.deleting ? "对话正在删除。" : "群聊已解散，请先恢复群聊。"); };
    const pending = this.performRequest(requestId, kind, input, id, operation);
    const set = this.pendingOperations.get(id) ?? new Set<Promise<unknown>>();
    this.pendingOperations.set(id, set); set.add(pending);
    void pending.finally(() => { set.delete(pending); if (!set.size) this.pendingOperations.delete(id); }).catch(() => {});
    return pending;
  }

  private async performRequest(requestId: string, action: string, payload: unknown, id: string,
    operation: (receipt: ConversationReceipt, commit: () => void) => Promise<void> | void): Promise<ConversationReceipt> {
    if (!/^[\w:-]{8,120}$/.test(requestId)) throw new Error("需要有效的 requestId。");
    const fingerprint = createHash("sha256").update(stableJson({ action, id, payload })).digest("hex");
    const existing = this.storage.getConversationRequest(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new AiTeamConflictError("requestId 已用于另一项操作，请先核对记录。");
      return existing.receipt; // Pending survives restart: never implicitly execute twice.
    }
    const receipt: ConversationReceipt = { requestId, state: "pending", conversationId: id };
    const commit = (): void => this.storage.saveConversationRequest({ id: requestId, fingerprint, receipt, updatedAt: now() });
    commit();
    try { await operation(receipt, commit); }
    catch (error) {
      // Reload the committed fact: a rolled-back transaction's in-memory mutation is not acceptance.
      const persisted = this.storage.getConversationRequest(requestId)?.receipt;
      if (persisted) { for (const key of Object.keys(receipt)) delete (receipt as unknown as Record<string, unknown>)[key]; Object.assign(receipt, persisted); }
      if (receipt.state === "pending") receipt.state = "rejected";
      else if (receipt.startup) receipt.startup = "failed";
      receipt.error = getErrorMessage(error);
      commit();
      return receipt;
    }
    commit();
    return receipt;
  }

  receipt(requestId: string): ConversationReceipt | null { return this.storage.getConversationRequest(requestId)?.receipt ?? null; }

  createGroup(requestId: string, input: GroupInput): Promise<ConversationReceipt> {
    return this.request(requestId, "create-group", input, "", (receipt, commit) => {
      const group = this.newGroup(input);
      this.storage.transaction(() => {
        this.storage.saveConversation(group);
        receipt.conversationId = group.id; receipt.state = "accepted"; commit();
      });
    });
  }

  invite(id: string, requestId: string, version: number, input: GroupInput): Promise<ConversationReceipt> {
    return this.request(requestId, "invite", { version, input }, id, (receipt) => {
      const group = this.requireInstance(id);
      if (group.kind !== "group" || !group.team) throw new Error("只能邀请到群聊。");
      if (group.memberVersion !== version) throw new AiTeamConflictError("群成员已更新，请核对名单后再邀请。");
      const proposed = this.groupTeam(input, "invite").team.members;
      const currentKeys = new Set(group.team.members.map(keyOf));
      const added = proposed.filter((m) => !currentKeys.has(keyOf(m))).map((member) => ({ ...member,
        id: `m_${randomUUID().replace(/-/g, "").slice(0, 8)}`, isLeader: false }));
      if (!added.length) throw new Error("所选成员已经在群中。");
      if (group.team.members.length + added.length > AI_TEAM_MAX_MEMBERS) throw new Error(`群最多 ${AI_TEAM_MAX_MEMBERS} 位员工。`);
      group.memberVersion += 1;
      for (const member of added) group.joinedVersions[keyOf(member)] = group.memberVersion;
      group.team = { ...group.team, members: [...group.team.members, ...added], updatedAt: now() };
      group.updatedAt = now();
      // The instance is the only writable roster; no template or run snapshot writer.
      this.storage.saveConversation(group);
      this.storage.appendConversationEvent(id, { role: "assistant", notice: true,
        messageId: randomUUID(), requestId, conversationTarget: null,
        content: [{ type: "text", text: `我邀请了 ${added.map((m) => m.name).join("、")}。下一次新派工生效。` }] });
      receipt.state = "accepted";
    });
  }

  private cwd(explicit?: string): string {
    if (!explicit?.trim() && !this.deps.config.defaultCwd?.trim()) throw new Error("请先选择聊天目录。");
    const cwd = resolveSessionCwd(explicit, this.deps.config.defaultCwd);
    if (!statSync(cwd).isDirectory()) throw new Error("聊天目录不存在。");
    return cwd;
  }

  private ensureRelay(group: ConversationInstance, cwd: string): string {
    if (group.sessionId && this.deps.structured.get(group.sessionId)) return group.sessionId;
    if (group.sessionId) throw new Error("群消息通道不可用，请核对服务状态；不会另建假群覆盖历史。");
    const leader = group.team!.members.find((m) => m.isLeader)!;
    const relay = this.deps.structured.createRelaySession({ cwd, provider: leader.agent.provider,
      mode: leader.agent.mode, title: group.name, automationId: `${CONVERSATION_RELAY_PREFIX}${group.id}`,
      worktreeEnabled: false, sessionSource: "interactive" });
    group.sessionId = relay.id;
    this.storage.saveConversation(group);
    return relay.id;
  }

  /** Explicit resource action may prepare a channel; it never sends or starts a model. */
  prepare(id: string, requestId: string, explicitCwd?: string): Promise<ConversationReceipt> {
    return this.request(requestId, "prepare", { explicitCwd }, id, (receipt) => {
      const instance = this.requireInstance(id);
      const session = this.communicationChannel(instance, this.cwd(explicitCwd));
      receipt.sessionId = session.id; receipt.state = "accepted";
    });
  }

  private communicationChannel(instance: ConversationInstance, cwd: string): SessionSnapshot {
    const leader = instance.team?.members.find((m) => m.isLeader);
    const employeeId = instance.peerEmployeeId ?? leader?.employeeId;
    const validated = employeeId ? requireTeamEmployee(this.storage, employeeId) : undefined;
    // The private default partner may use its own habits; group channels never inherit the DM projection.
    const employee = instance.kind === "dm" && employeeId ? this.storage.getSiliconEmployee(employeeId)! : validated;
    const selected = employee ? selectEmployeeCandidate(employee) : null;
    const agent = selected?.agent ?? leader?.agent;
    if (!agent || agent.kind !== "structured") throw new Error("群内沟通需要负责人的结构化候选；不会切换另一执行引擎。");
    let session = instance.communicationSessionId ? this.deps.structured.get(instance.communicationSessionId) : null;
    if (!session) {
      if (instance.communicationSessionId) instance.historySessionIds = [...(instance.historySessionIds ?? []), instance.communicationSessionId];
      const model = agent.model === "default"
        ? defaultModelGroupSelector(this.deps.config.modelGroups, agent.provider, getDefaultModelForProvider(this.deps.config, agent.provider))
          || getDefaultModelForProvider(this.deps.config, agent.provider) || undefined : agent.model;
      session = this.deps.structured.createSession({ cwd, provider: agent.provider, mode: agent.mode, model,
        thinkingEffort: agent.thinkingEffort, worktreeEnabled: false, sessionSource: "interactive",
        automationId: `conversation-talk:${instance.id}`, employeeId: employee?.id,
        employeeName: employee?.name ?? leader?.name, employeeAvatar: employee?.avatar ?? leader?.avatar,
        employeeCandidates: employee?.agents, employeeCandidateIndex: selected?.index,
        systemPrompt: [employee?.prompt ?? "", instance.kind === "group"
          ? `你在群聊「${instance.name}」中以负责人身份沟通。普通沟通不等同派任务、审批或执行；仅使用本群上下文，不引用你的日常私聊。\n${instance.team?.instructions ?? ""}` : ""].filter(Boolean).join("\n\n") });
      instance.communicationSessionId = session.id;
      if (instance.kind === "dm") instance.sessionId = session.id;
    }
    instance.createdAt ||= now(); instance.updatedAt = now();
    this.storage.saveConversation(instance);
    return session;
  }

  send(id: string, requestId: string, input: string, target: ConversationTarget, explicitCwd?: string, echo = true): Promise<ConversationReceipt> {
    return this.request(requestId, "send", { input, target, explicitCwd, echo }, id, async (receipt, commit) => {
      const text = shortText(input, "消息", 256_000, true);
      const instance = this.requireInstance(id);
      if (target) {
        const run = this.requireTarget(instance, target);
        if (!AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status)) throw new Error("本轮已结束，请显式选择群内沟通或继续此任务。");
        const mention = conversationLeaderMention(text, run.team.members);
        if (mention && "error" in mention) throw new Error(mention.error);
        if (mention && mention.memberId !== run.team.members.find(m => m.isLeader)?.id) {
          throw new AiTeamConflictError("本轮负责人已确定；请结束本轮，再用 @成员 派新任务，不会中途换人或重复执行。");
        }
        receipt.taskId = target.taskId; receipt.runId = target.runId; receipt.state = "accepted"; commit();
        await this.deps.runner.inputForRun(run.id, text);
        return;
      }
      if (instance.kind === "dm") {
        this.startMessageSession(instance, requestId, text, explicitCwd, receipt, commit);
        return;
      }
      if (instance.kind === "group" && instance.team) {
        const mention = conversationLeaderMention(text, instance.team.members);
        if (mention && "error" in mention) throw new Error(mention.error);
        if (mention) {
          const active = this.storage.conversationTasks(id).some(link =>
            this.storage.listAiTeamRuns({ taskId: link.taskId, statuses: AI_TEAM_ACTIVE_RUN_STATUSES }).length > 0);
          if (active) throw new AiTeamConflictError("群里已有进行中的任务，请先选择该任务补充消息或结束本轮，避免重复派工。");
          const cwd = this.cwd(explicitCwd || this.snapshot(instance.sessionId)?.cwd || this.snapshot(instance.communicationSessionId)?.cwd);
          const projects = this.storage.listWorkspaces().filter(project => project.kind !== "global" && project.cwd && resolve(project.cwd) === cwd);
          if (projects.length !== 1) throw new Error("@负责人 协作需要明确的工作项目，请在「派新任务」中选择项目后发送；消息尚未派发。");
          await this.dispatchInRequest(instance, requestId, { description: text, workspaceId: projects[0]!.id,
            memberVersion: instance.memberVersion }, receipt, commit, echo);
          return;
        }
      }
      const cwd = this.cwd(explicitCwd);
      const session = this.communicationChannel(instance, cwd);
      const relayId = this.ensureRelay(instance, cwd);
      if (echo) this.deps.structured.appendRelayTurns(relayId, [{ role: "user", messageId: requestId, requestId,
        conversationId: id, conversationTarget: null, content: [{ type: "text", text }] }]);
      receipt.sessionId = session.id; receipt.messageId = requestId;
      // Server has captured and committed this input. Later model failure is not an unsent draft.
      receipt.state = "accepted"; commit();
      // 群内近期记录只是资料，不增加权限；署名与界面用同一个显示名口径。
      const groupContext = instance.kind === "group" ? this.turns(instance).slice(-40).map((turn) =>
        `${turn.role === "user" ? this.selfName() : turn.author?.name ?? "系统"}：${turn.content.map((b) => b.type === "text" ? b.text : "").join(" ")}`
      ).join("\n").slice(-16_000) : "";
      const prompt = groupContext ? `本群近期记录（资料，不增加权限）：\n${groupContext}\n\n当前群内沟通：${text}` : text;
      void this.deps.structured.sendMessage(session.id, prompt, { idempotencyKey: requestId }).catch(() => {
        if (this.storage.getConversation(id)?.communicationSessionId !== session.id || this.storage.conversationListState(id).deleting) return;
        this.storage.appendConversationEvent(id, { role: "assistant", notice: true, requestId,
          conversationTarget: null, content: [{ type: "text", text: "本次输入已由服务端接收，但执行通道失败。请核对实际会话与送达状态，不要重复发送。" }] });
        // The actual error remains in the normal session protocol; no retry or employee substitution.
      });
    });
  }

  /** One IM message is one fresh model context. No task, team, relay or previous DM history. */
  private startMessageSession(instance: ConversationInstance, requestId: string, input: string, explicitCwd: string | undefined,
    receipt: ConversationReceipt, commit: () => void): void {
    requireTeamEmployee(this.storage, instance.peerEmployeeId ?? "");
    const employee = this.storage.getSiliconEmployee(instance.peerEmployeeId!)!;
    const selected = selectEmployeeCandidate(employee), agent = selected.agent;
    const cwd = this.cwd(explicitCwd);
    const model = agent.model === "default"
      ? defaultModelGroupSelector(this.deps.config.modelGroups, agent.provider, getDefaultModelForProvider(this.deps.config, agent.provider))
        || getDefaultModelForProvider(this.deps.config, agent.provider) || undefined : agent.model;
    const title = provisionalTaskTitleFromDescription(conversationMessageBody(input)) || "新会话";
    let session: SessionSnapshot | undefined;
    try {
      this.storage.acceptConversationSession(instance, () => {
        session = this.deps.structured.createSession({ title, cwd, provider: agent.provider, mode: agent.mode, model,
          thinkingEffort: agent.thinkingEffort, worktreeEnabled: false, sessionSource: "interactive",
          workspaceId: resolveWorkspaceIdForNewSession(this.storage, cwd),
          automationId: `${CONVERSATION_SESSION_PREFIX}${requestId}`, employeeId: employee.id,
          employeeName: employee.name, employeeAvatar: employee.avatar, employeeCandidates: employee.agents,
          employeeCandidateIndex: selected.index, systemPrompt: employee.prompt });
        return session.id;
      }, title, input, this.storage.getConversationRequest(requestId)!);
    } catch (error) {
      if (session) this.deps.deleteSession?.(session.id);
      throw error;
    }
    Object.assign(receipt, this.storage.getConversationRequest(requestId)!.receipt);
    receipt.startup = "started"; commit();
    // The session and both messages are durable before the first byte can reach a model.
    void this.deps.structured.sendMessage(session!.id, input, { idempotencyKey: requestId }).catch(error => {
      if (!this.storage.getConversation(instance.id) || this.storage.conversationListState(instance.id).deleting
        || !this.snapshot(session!.id)) return;
      receipt.startup = "failed"; receipt.error = getErrorMessage(error); commit();
      this.ingestSessionEvent({ type: "status", sessionId: session!.id, data: {} });
    });
  }

  private requireTarget(instance: ConversationInstance, target: { taskId: string; runId: string }): AiTeamRun {
    if (instance.kind !== "group" || !this.storage.conversationTasks(instance.id).some((t) => t.taskId === target.taskId)) {
      throw new Error("任务不属于这个群聊。");
    }
    const run = this.storage.getAiTeamRun(target.runId);
    if (!run || run.taskId !== target.taskId || run.chatSessionId !== instance.sessionId) throw new Error("本轮不属于这个群聊任务。");
    return run;
  }

  dispatch(id: string, requestId: string, input: ConversationDispatchInput): Promise<ConversationReceipt> {
    return this.request(requestId, "dispatch", input, id, (receipt, commit) => {
      const instance = this.requireInstance(id);
      // Older clients may still use the task form in a DM. It now starts a session, never a task group.
      if (instance.kind === "dm") {
        if (input.continueTaskId) throw new Error("请到原任务群继续历史任务。");
        const workspace = input.workspaceId ? this.storage.getWorkspace(input.workspaceId) : null;
        if (input.workspaceId && (!workspace?.cwd || workspace.kind === "global")) throw new Error("请选择有效的工作项目。");
        this.startMessageSession(instance, requestId, shortText(input.description, "消息", 256_000, true), workspace?.cwd || input.cwd, receipt, commit);
        return;
      }
      return this.dispatchInRequest(instance, requestId, input, receipt, commit);
    });
  }

  /** Both explicit task forms and leading @ messages share one atomic acceptance/idempotency boundary. */
  private async dispatchInRequest(original: ConversationInstance, requestId: string, input: ConversationDispatchInput,
    receipt: ConversationReceipt, commit: () => void, echo = true): Promise<void> {
    const description = shortText(input.description, "任务说明", 256_000, true);
    const mention = original.kind === "group" ? conversationLeaderMention(description, (original.team?.members ?? [])) : null;
    if (mention && "error" in mention) throw new Error(mention.error);
    // Explicit group work only; continuing a task keeps its original title.
    const taskTitle = input.continueTaskId ? "" : shortText(input.title, "任务标题", 200)
      || provisionalTaskTitleFromDescription(mention?.body ?? conversationMessageBody(description)) || "新任务";
    // 自建/自动群跟随最新任务标题，实例名与列表里的任务标题投影保持一致；预设群保留模板名。
    if (original.kind === "group" && original.nameSource === "auto" && !original.sourceTemplateId && taskTitle) {
      original.name = taskTitle.slice(0, 120); original.updatedAt = now();
    }
    const group = original;
    if (!group.team) throw new Error("群配置不可用。");
    if (input.memberVersion !== undefined && input.memberVersion !== group.memberVersion) throw new AiTeamConflictError("群成员已更新，请核对名单。");
    // Change only this run's frozen roster. Never rewrite the group, template, employees or old runs.
    const definition = mention ? { ...group.team, allowLeaderWork: true,
      members: group.team.members.map(member => ({ ...member, isLeader: member.id === mention.memberId })) } : group.team;
    const team = freezeTeamEmployees(definition, this.storage); // validate before committing task/group
    const workspace = input.workspaceId ? this.storage.getWorkspace(input.workspaceId) : null;
    if (!workspace || workspace.kind === "global" || !workspace.cwd) throw new Error("请选择非全局工作项目。");
    this.cwd(workspace.cwd);
    let previous;
    if (input.continueTaskId) {
      if (!this.storage.conversationTasks(group.id).some((t) => t.taskId === input.continueTaskId)) throw new Error("任务不属于这个群聊。");
      previous = this.storage.getWandTask(input.continueTaskId);
      if (!previous || previous.workspaceId !== workspace.id) throw new Error("继续任务必须使用原工作项目。");
      if (this.storage.listAiTeamRuns({ taskId: previous.id, statuses: AI_TEAM_ACTIVE_RUN_STATUSES }).length) throw new AiTeamConflictError("请先结束或停止该任务的旧轮次。");
    }
    const task = this.storage.acceptConversationDispatch(group, previous ? { continueTaskId: previous.id } : { workspaceId: workspace.id,
      title: taskTitle, description, labels: ["conversation_task"], agent: team.members.find((m) => m.isLeader)!.agent },
    this.storage.getConversationRequest(requestId)!);
    Object.assign(receipt, this.storage.getConversationRequest(requestId)!.receipt);
    // Everything after this atomic boundary is startup, never rejection or a new task.
    const relayId = this.ensureRelay(group, workspace.cwd);
    let accepted = false;
    const completion = this.deps.runner.start({ team, taskId: task.id, note: description, chatSessionId: relayId,
      conversationId: group.id, memberVersion: group.memberVersion, onAccepted: (run) => {
        receipt.runId = run.id; receipt.startup = "started"; accepted = true; commit();
      } });
    if (!accepted) await completion;
    else void completion.catch((error) => {
      receipt.startup = "failed"; receipt.error = getErrorMessage(error); commit();
      // Keep the real run/steps and accepted task; no rollback, fallback or automatic restart.
    });
    if (echo) this.deps.structured.appendRelayTurns(relayId, [{ role: "user", messageId: requestId, requestId,
      conversationId: group.id, conversationTarget: receipt.runId ? { taskId: task.id, runId: receipt.runId } : null,
      content: [{ type: "text", text: description }] }]);
  }

  act(id: string, requestId: string, target: { taskId: string; runId: string }, action: string, extraSteps?: number): Promise<ConversationReceipt> {
    return this.request(requestId, "act", { target, action, extraSteps }, id, async (receipt, commit) => {
      const run = this.requireTarget(this.requireInstance(id), target);
      if (!["approve", "stop", "continue"].includes(action)) throw new Error("未知运行操作。");
      if (!AI_TEAM_ACTIVE_RUN_STATUSES.includes(run.status)) throw new Error("本轮已结束。");
      if (action === "approve" && run.status !== "awaiting_approval") throw new Error("本轮没有待批准的计划。");
      if (action === "continue" && run.status !== "waiting_user") throw new Error("本轮没有暂停在步数上限。");
      receipt.taskId = target.taskId; receipt.runId = target.runId; receipt.state = "accepted"; commit();
      if (action === "approve") await this.deps.runner.approve(run.id);
      else if (action === "stop") await this.deps.runner.stop(run.id);
      else if (action === "continue") await this.deps.runner.continueRun(run.id, extraSteps ?? 10);
      else throw new Error("未知运行操作。");
      receipt.taskId = target.taskId; receipt.runId = target.runId; receipt.state = "accepted";
    });
  }
}
