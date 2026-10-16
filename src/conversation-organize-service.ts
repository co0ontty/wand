import { createHash, randomUUID } from "node:crypto";
import type { WandStorage } from "./storage.js";
import { getDefaultModelForProvider } from "./config.js";
import { SESSION_PROVIDERS } from "./provider-catalog.js";
import type { SessionSnapshot } from "./types.js";
import type { AutoTaskTitleOptions } from "./task-title-service.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { callConfiguredAiText } from "./ai-text-runner.js";
import { isGlobalWorkspace, normalizeProjectCwd, projectCwdForSession } from "./workspace-binding.js";
import { isSystemAiCall } from "./system-ai-call.js";
import { systemAiSessions, redactSystemAiText } from "./system-ai-session-recorder.js";
import { taskAutoNameSignature, taskAutoNameSourceText } from "./wand-task-sync.js";
import { conversationContent, conversationGroupingPrompt, parseConversationGrouping, summaryPrompt, parseConversationSummary,
  ORGANIZE_CONTENT_CHUNK, ORGANIZE_SUMMARY_LIMIT, ORGANIZE_GROUP_BATCH,
  type ConversationGroupingJudge, type ConversationGroupingInput, type ConversationGroupingPlan } from "./conversation-organize.js";
import type { ConversationOrganizationScope, ConversationOrganizationPreview, ConversationOrganizationResult, ConversationOrganizationJob } from "./conversation-organize-contract.js";

const MAX_SESSIONS = 500;
const MAX_MODEL_REQUESTS = 100;
const MAX_REFERENCE_TASKS = 40;
const PREVIEW_TTL = 5 * 60_000;
const services = new WeakMap<WandStorage, ConversationOrganizationService>();
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Container = NonNullable<ReturnType<WandStorage["getWorkspaceTask"]>>;
type Card = NonNullable<ReturnType<WandStorage["getWandTask"]>>;
interface Task { container: Container; card: Card; directory: string; }
interface Item { session: SessionSnapshot; text: string; userRevision: string; directory: string; workspaceId: string | null; }
interface Scan { scope: ConversationOrganizationScope; items: Item[]; tasks: Task[]; found: number; manual: number; skipped: number; fingerprint: string; confirmationFingerprint: string; estimated: number; chars: number; }
interface PreviewEntry { scan: Scan; createdAt: number; }
export interface ConversationOrganizationDependencies {
  titleOptions?: AutoTaskTitleOptions;
  judge?: ConversationGroupingJudge;
  summarize?(text: string, index: number, total: number, signal: AbortSignal): Promise<string>;
  listSessions?(): SessionSnapshot[];
  getSession?(id: string): SessionSnapshot | null;
  refreshSession?(id: string): void;
}
function emptyResult(scan: Scan): ConversationOrganizationResult {
  return { ok: true, foundSessions: scan.found, eligibleSessions: scan.items.length, skippedManualSessions: scan.manual,
    skippedSessions: scan.skipped, analyzedSessions: 0, createdTasks: [], reusedTasks: [], updatedTasks: [], movedSessions: [], unassignedSessions: [], refused: [] };
}
function summaryCalls(chars: number): number {
  if (chars <= ORGANIZE_SUMMARY_LIMIT) return 0;
  let count = 0;
  while (chars > ORGANIZE_SUMMARY_LIMIT) { const chunks = Math.ceil(chars / ORGANIZE_CONTENT_CHUNK); count += chunks; chars = chunks * ORGANIZE_SUMMARY_LIMIT; if (chunks === 1) break; }
  return count;
}

export class ConversationOrganizationService {
  private readonly previews = new Map<string, PreviewEntry>();
  private readonly active = new Map<string, AbortController>();
  private readonly executing = new Set<string>();
  private readonly scopeJobs = new Map<string, string>();
  private readonly jobs = new Map<string, ConversationOrganizationJob>();
  private readonly operationTraces = new Map<string, import("./system-ai-call.js").AiCallTrace>();
  private readonly roleVersions = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly storage: WandStorage, private readonly deps: ConversationOrganizationDependencies) {
    for (const job of storage.listRunningConversationOrganizationJobs()) {
      job.status = "interrupted"; job.stage = "服务重启，未自动重放；已保存的任务与归属保留。"; job.error = job.stage;
      storage.saveConversationOrganizationJob(job);
    }
    storage.onClose(() => {
      for (const [id, controller] of this.active) {
        controller.abort(Object.assign(new Error("服务关闭"), { code: "SERVICE_SHUTDOWN" }));
        const job = this.jobs.get(id);
        if (job?.status === "running") { job.status = "interrupted"; job.error = "服务关闭，已保存部分保留，未自动重做。"; job.stage = job.error; this.save(job); }
      }
      this.closed = true; this.active.clear();
    });
  }
  private save(job: ConversationOrganizationJob): void { if (!this.closed) this.storage.saveConversationOrganizationJob(job); }
  private scopeKey(scope: ConversationOrganizationScope): string { return hash({ ...scope, taskIds: [...(scope.taskIds ?? [])].sort(), sessionIds: [...(scope.sessionIds ?? [])].sort() }); }
  private getSession(id: string): SessionSnapshot | null { return this.deps.getSession?.(id) ?? this.storage.getSession(id); }
  private taskDirectory(container: Container): string {
    const workspace = this.storage.getWorkspace(container.workspaceId);
    return normalizeProjectCwd(workspace && !isGlobalWorkspace(workspace) ? workspace.cwd : container.worktree?.path ?? container.cwd ?? workspace?.cwd ?? "");
  }
  private inScope(scope: ConversationOrganizationScope, session: SessionSnapshot, task: Task | undefined, directory: string): boolean {
    if (!scope.target) return (scope.sessionIds ?? []).includes(session.id) || !!session.workspaceTaskId && (scope.taskIds ?? []).includes(session.workspaceTaskId);
    if (scope.target.kind === "all") return true;
    if (scope.target.kind === "directory") return directory === normalizeProjectCwd(scope.target.cwd);
    const workspace = this.storage.getWorkspace(scope.target.workspaceId);
    if (!workspace) return false;
    if (task) {
      const owner = this.storage.getWorkspace(task.container.workspaceId);
      return task.container.workspaceId === workspace.id || !!owner && isGlobalWorkspace(owner) && directory === normalizeProjectCwd(workspace.cwd);
    }
    const owner = session.workspaceId ? this.storage.getWorkspace(session.workspaceId) : null;
    if (owner && owner.id !== workspace.id && !isGlobalWorkspace(owner)) return false;
    return directory === normalizeProjectCwd(workspace.cwd);
  }
  private scan(scope: ConversationOrganizationScope): Scan {
    const cards = new Map(this.storage.listWandTasks().filter(card => card.workspaceTaskId).map(card => [card.workspaceTaskId!, card]));
    const tasks = this.storage.listAllWorkspaceTasks().flatMap(container => { const card = cards.get(container.id); return card ? [{ container, card, directory: this.taskDirectory(container) }] : []; });
    const byId = new Map(tasks.map(task => [task.container.id, task]));
    const workspaces = this.storage.listWorkspaces().filter(workspace => !isGlobalWorkspace(workspace));
    const items: Item[] = [];
    let found = 0, manual = 0, skipped = 0, chars = 0;
    for (const slim of this.deps.listSessions?.() ?? this.storage.loadSessionsSlim()) {
      const task = slim.workspaceTaskId ? byId.get(slim.workspaceTaskId) : undefined;
      const directory = task?.directory || projectCwdForSession(slim);
      if (!this.inScope(scope, slim, task, directory)) continue;
      found++;
      if (slim.archived || task?.container.archived || task?.card.status === "archived" || isSystemAiCall(slim)
        || slim.automationId || slim.sessionSource && slim.sessionSource !== "interactive") { skipped++; continue; }
      if (scope.mode === "auto" && task && task.card.titleSource !== "auto") { manual++; continue; }
      const full = this.getSession(slim.id);
      if (!full) { skipped++; continue; }
      const content = conversationContent(full);
      if (!content.text || !directory) { skipped++; continue; }
      let workspaceId: string | null = null;
      const direct = task ? this.storage.getWorkspace(task.container.workspaceId) : slim.workspaceId ? this.storage.getWorkspace(slim.workspaceId) : null;
      if (direct && !isGlobalWorkspace(direct)) workspaceId = direct.id;
      else {
        const matches = workspaces.filter(workspace => normalizeProjectCwd(workspace.cwd) === directory);
        if (matches.length > 1 && scope.target?.kind !== "workspace") { skipped++; continue; }
        workspaceId = scope.target?.kind === "workspace" ? scope.target.workspaceId : matches[0]?.id ?? null;
      }
      const safeText = redactSystemAiText(content.text);
      chars += safeText.length;
      if (chars > 2_000_000) throw new Error("本次正文超过200万字符，请按目录或多选会话分批整理；未截断或调用模型。");
      items.push({ session: full, text: safeText, userRevision: hash(content.userRevision), directory, workspaceId });
    }
    if (items.length > MAX_SESSIONS) throw new Error(`本次有 ${items.length} 个工作会话，超过单次 ${MAX_SESSIONS} 个上限；请按目录或多选会话分批，未处理任何会话。`);
    const eligibleTasks = tasks.filter(task => !task.container.archived && task.card.status !== "archived" && (scope.mode === "all" || task.card.titleSource === "auto")
      && (scope.target || !scope.taskIds?.length || scope.taskIds.includes(task.container.id)));
    const groupingBatches = new Map<string, number>();
    for (const item of items) { const key = item.directory + ":" + item.workspaceId; groupingBatches.set(key, (groupingBatches.get(key) ?? 0) + 1); }
    const estimated = items.reduce((sum, item) => sum + summaryCalls(item.text.length), 0) + [...groupingBatches.values()].reduce((sum, count) => sum + Math.ceil(count / ORGANIZE_GROUP_BATCH), 0);
    if (estimated > MAX_MODEL_REQUESTS) throw new Error(`本次正文预计需要 ${estimated} 个系统模型请求，超过单次 ${MAX_MODEL_REQUESTS} 个保护上限；请缩小到单个目录或多选会话，未发起模型调用。`);
    const taskCounts = new Map<string, number>();
    for (const task of eligibleTasks) if (items.some(item => item.directory === task.directory)) taskCounts.set(task.directory, (taskCounts.get(task.directory) ?? 0) + 1);
    if ([...taskCounts.values()].some(count => count > MAX_REFERENCE_TASKS)) throw new Error(`某个目录有超过 ${MAX_REFERENCE_TASKS} 个候选任务；请缩小多选任务范围或先归档旧任务，未截断会话内容或发起模型。`);
    const fingerprint = this.fingerprint(items, eligibleTasks);
    const confirmationFingerprint = this.fingerprint(items, eligibleTasks, true);
    return { scope, items, tasks: eligibleTasks, found, manual, skipped, fingerprint, confirmationFingerprint, estimated, chars };
  }
  private fingerprint(items: Item[], tasks: Task[], confirmation = false): string {
    return hash({ sessions: items.map(item => [item.session.id, item.session.workspaceTaskId ?? null, item.session.workspaceId ?? null,
      confirmation ? item.userRevision : hash(item.text)]).sort(),
      tasks: tasks.filter(task => items.some(item => item.directory === task.directory)).map(task => [task.container.id,
        confirmation && task.card.titleSource === "auto" ? null : task.card.title, task.card.description, task.card.titleSource, task.card.status]).sort() });
  }
  prepare(scope: ConversationOrganizationScope): ConversationOrganizationPreview {
    const scan = this.scan(scope), token = randomUUID();
    for (const [id, preview] of this.previews) if (Date.now() - preview.createdAt > PREVIEW_TTL) this.previews.delete(id);
    while (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, { scan, createdAt: Date.now() });
    return { token, sessionCount: scan.items.length, manualSessionCount: scan.manual, skippedSessionCount: scan.skipped,
      existingTaskCount: scan.tasks.filter(task => scan.items.some(item => item.directory === task.directory)).length,
      contentCharacters: scan.chars, estimatedModelRequests: scan.estimated,
      activeJobId: this.scopeJobs.has(this.scopeKey(scope)) && this.get(this.scopeJobs.get(this.scopeKey(scope))!)?.status === "running" ? this.scopeJobs.get(this.scopeKey(scope)) : undefined,
      unchanged: this.storage.getConversationOrganizationFingerprint(this.scopeKey(scope)) === scan.fingerprint };
  }
  start(token: string, force = false): ConversationOrganizationJob {
    const accepted = this.storage.getConversationOrganizationJobByToken(token);
    if (accepted) return this.get(accepted.id)!;
    const preview = this.previews.get(token);
    if (!preview || Date.now() - preview.createdAt > PREVIEW_TTL) throw new Error("归类预览已过期，请重新选择范围确认。");
    const scopeKey = this.scopeKey(preview.scan.scope), prior = this.scopeJobs.get(scopeKey);
    if (prior) { const existing = this.get(prior); if (existing?.status === "running") return existing; }
    const current = this.scan(preview.scan.scope);
    const scan = preview.scan;
    if (current.confirmationFingerprint !== scan.confirmationFingerprint) throw new Error("预览后会话内容或归属已变化，请重新预览确认。");
    const job: ConversationOrganizationJob = { id: randomUUID(), status: "running", stage: "等待开始会话内容整理", processedSessions: 0,
      totalSessions: scan.items.length, modelRequests: 0, result: emptyResult(scan) };
    if (!scan.items.length || !force && this.storage.getConversationOrganizationFingerprint(scopeKey) === scan.fingerprint) {
      job.status = "completed"; job.result.unchanged = !!scan.items.length; job.stage = scan.items.length ? "内容和归属未变化，没有重复建任务或调用模型。" : "没有符合范围且有正文的工作会话。";
      this.storage.saveConversationOrganizationJob(job, token, scopeKey); return job;
    }
    if ([...this.active.keys()].filter(id => this.jobs.get(id)?.status === "running").length >= 10) throw new Error("已有10个归类作业在执行或等待，请先完成或取消后再确认；未发起新模型请求。");
    const employee = this.storage.getSystemSiliconEmployee();
    if (!employee) throw new Error("系统员工初二尚未初始化，未开始归类。");
    if (employee) {
      const operationCwd = scan.scope.target?.kind === "directory" ? scan.scope.target.cwd
        : scan.scope.target?.kind === "workspace" ? this.storage.getWorkspace(scan.scope.target.workspaceId)?.cwd
        : scan.items.every(item => item.directory === scan.items[0]!.directory) ? scan.items[0]!.directory : undefined;
      const trace = systemAiSessions(this.storage).forEmployee(employee).start("conversation-organize-job", {
        system: "后台会话归类作业已受理。本记录统筹业务，不直接调用模型；真实摘要和归组请求另有调用会话。",
        prompt: JSON.stringify({ jobId: job.id, scope: scan.scope, sessionIds: scan.items.map(item => item.session.id), estimatedModelRequests: scan.estimated }),
      }, operationCwd || this.deps.titleOptions?.config?.defaultCwd || process.cwd());
      job.logSessionId = trace.sessionId; this.operationTraces.set(job.id, trace);
    }
    this.roleVersions.set(job.id, this.roleVersion());
    this.jobs.set(job.id, job); this.scopeJobs.set(scopeKey, job.id);
    const controller = new AbortController(); this.active.set(job.id, controller);
    this.storage.saveConversationOrganizationJob(job, token, scopeKey);
    this.tail = this.tail.catch(() => {}).then(async () => {
      this.executing.add(job.id);
      try { await this.execute(job, scan, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)])); }
      finally { this.active.delete(job.id); this.executing.delete(job.id); if (this.scopeJobs.get(scopeKey) === job.id) this.scopeJobs.delete(scopeKey); this.operationTraces.delete(job.id); this.roleVersions.delete(job.id); this.save(job); this.jobs.delete(job.id); }
    });
    return job;
  }
  get(id: string): ConversationOrganizationJob | null { return this.jobs.get(id) ?? this.storage.getConversationOrganizationJob(id); }
  cancel(id: string): ConversationOrganizationJob | null {
    const job = this.get(id);
    const reason = Object.assign(new Error("用户取消"), { code: "USER_CANCELLED" });
    this.active.get(id)?.abort(reason);
    if (job?.status === "running" && !this.executing.has(id)) {
      job.status = "cancelled"; job.result.cancelled = true; job.stage = "已取消等待，未发起模型调用。";
      this.operationTraces.get(id)?.fail(reason, true); this.save(job);
    }
    return job;
  }

  private ai(purpose: "conversation-summary" | "conversation-organize", sourceId: string | undefined, onCall: (id: string) => void) {
    const config = this.deps.titleOptions?.config;
    if (!config) throw new Error("服务端未启用系统 AI 配置。");
    return { ...resolveSystemAiContext({ id: sourceId, provider: config.defaultProvider ?? "pi", command: config.defaultProvider ?? "pi", selectedModel: null, thinkingEffort: "off" },
      config, this.storage.getSystemSiliconEmployee(), this.deps.titleOptions?.free, { storage: this.storage, purpose }), onCallSessionCreated: onCall };
  }
  private async summarize(item: Item, job: ConversationOrganizationJob, signal: AbortSignal, onCall: (id: string) => void): Promise<string> {
    let text = item.text;
    while (text.length > ORGANIZE_SUMMARY_LIMIT) {
      const chunks: string[] = [];
      for (let at = 0; at < text.length; at += ORGANIZE_CONTENT_CHUNK) chunks.push(text.slice(at, at + ORGANIZE_CONTENT_CHUNK));
      const summaries: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        signal.throwIfAborted();
        this.countModelRequest(job);
        const summary = this.deps.summarize ? await this.deps.summarize(chunks[i]!, i, chunks.length, signal)
          : await callConfiguredAiText(summaryPrompt(chunks[i]!, i, chunks.length), this.deps.titleOptions?.config?.defaultCwd ?? process.cwd(), "中文", { ...this.ai("conversation-summary", item.session.id, onCall), signal }, parseConversationSummary);
        if (!summary.trim() || summary.length > ORGANIZE_SUMMARY_LIMIT) throw new Error("会话摘要不符合长度约束。");
        summaries.push(summary);
      }
      text = summaries.join("\n\n");
    }
    return text;
  }
  private taskCandidates(scan: Scan, item: Item): Task[] {
    const normalMatches = this.storage.listWorkspaces().filter(workspace => !isGlobalWorkspace(workspace) && normalizeProjectCwd(workspace.cwd) === item.directory).length;
    return scan.tasks.filter(task => task.directory === item.directory
      && (task.card.workspaceId === item.workspaceId || task.card.workspaceId === null && normalMatches <= 1)
      && (scan.scope.target?.kind !== "workspace" || task.container.workspaceId === scan.scope.target.workspaceId));
  }
  private roleVersion(): string {
    const role = this.storage.getSystemSiliconEmployee();
    const config = this.deps.titleOptions?.config;
    return hash({ role: role && { id: role.id, updatedAt: role.updatedAt, agents: role.agents, prompt: role.prompt },
      groups: config?.modelGroups, defaults: config && SESSION_PROVIDERS.map(provider => getDefaultModelForProvider(config, provider)) });
  }
  private countModelRequest(job: ConversationOrganizationJob): void {
    if (this.roleVersions.get(job.id) !== this.roleVersion()) throw Object.assign(new Error("初二配置已变化，请重新预览确认。"), { code: "ORGANIZE_ROLE_CHANGED" });
    if (job.modelRequests >= MAX_MODEL_REQUESTS) throw Object.assign(new Error("系统模型请求达到本次预算上限。"), { code: "ORGANIZE_BUDGET" });
    job.modelRequests++; this.save(job);
  }
  private async execute(job: ConversationOrganizationJob, scan: Scan, signal: AbortSignal): Promise<void> {
    const callIds: string[] = [];
    const operationTrace = this.operationTraces.get(job.id);
    try {
      signal.throwIfAborted();
      const buckets = new Map<string, Item[]>();
      for (const item of scan.items) { const key = item.directory + ":" + item.workspaceId; buckets.set(key, [...(buckets.get(key) ?? []), item]); }
      for (const bucket of buckets.values()) {
        for (let at = 0; at < bucket.length; at += ORGANIZE_GROUP_BATCH) {
          signal.throwIfAborted();
          const batch = bucket.slice(at, at + ORGANIZE_GROUP_BATCH);
          const summarized = [];
          for (const item of batch) {
            job.stage = `读取并归纳会话正文 ${job.result.analyzedSessions + 1}/${scan.items.length}`; this.save(job);
            summarized.push({ id: item.session.id, title: item.session.title ?? "", currentTaskId: item.session.workspaceTaskId ?? null,
              content: await this.summarize(item, job, signal, id => callIds.push(id)) });
            job.result.analyzedSessions++;
          }
          // Refresh target candidates after previous batches created tasks; later batches can reuse them.
          const candidates = this.taskCandidates(scan, batch[0]!);
          const input: ConversationGroupingInput = { sessions: summarized, tasks: candidates.map(task => ({ id: task.container.id, title: redactSystemAiText(task.card.title.slice(0, 80)), titleTruncated: task.card.title.length > 80, description: redactSystemAiText(task.card.description.slice(0, 240)), descriptionTruncated: task.card.description.length > 240 })) };
          job.stage = `按正文语义规划任务（已处理 ${job.processedSessions}/${scan.items.length}）`; this.save(job);
          this.countModelRequest(job);
          const plan = this.deps.judge ? await this.deps.judge(input, signal)
            : await callConfiguredAiText(conversationGroupingPrompt(input), this.deps.titleOptions?.config?.defaultCwd ?? process.cwd(), "中文",
              { ...this.ai("conversation-organize", job.logSessionId, id => callIds.push(id)), signal }, raw => parseConversationGrouping(raw, input));
          // Test adapters and production share the same complete-membership/domain validator.
          const checked = parseConversationGrouping(JSON.stringify(plan), input);
          signal.throwIfAborted();
          this.apply(job, batch, candidates, checked, scan.scope.mode);
          for (const created of job.result.createdTasks) {
            if (scan.tasks.some(task => task.container.id === created.taskId)) continue;
            const container = this.storage.getWorkspaceTask(created.taskId), card = this.storage.getWandTask(created.cardId);
            if (container && card) scan.tasks.push({ container, card, directory: this.taskDirectory(container) });
          }
          for (const updated of job.result.updatedTasks) {
            const prior = scan.tasks.find(task => task.container.id === updated.taskId);
            const card = prior && this.storage.getWandTask(prior.card.id);
            if (prior && card) prior.card = card;
          }
        }
      }
      job.status = "completed"; job.stage = "会话自动归类完成";
      if (!job.result.refused.length && !job.result.unassignedSessions.length)
        this.storage.saveConversationOrganizationFingerprint(this.scopeKey(scan.scope), this.fingerprint(scan.items.map(item => ({ ...item,
          session: { ...item.session, ...this.storage.getSessionWorkspace(item.session.id) } })), scan.tasks.map(task => ({ ...task,
            card: { ...task.card, status: this.storage.getWandTask(task.card.id)?.status ?? task.card.status } }))));
      operationTrace?.applicationResult(job.result); operationTrace?.complete();
    } catch (error) {
      const cancelled = signal.aborted && signal.reason?.code === "USER_CANCELLED";
      const interrupted = this.closed || signal.reason?.code === "SERVICE_SHUTDOWN";
      job.status = interrupted ? "interrupted" : cancelled ? "cancelled" : "failed";
      job.result.cancelled = cancelled;
      job.error = interrupted ? "服务关闭，已完成部分保留，未自动重做。" : cancelled ? "已取消后续归类；已经完成的任务与归属保留。"
        : signal.reason?.name === "TimeoutError" ? "归类达到30分钟保护上限；已完成部分保留，请缩小范围。"
          : error && typeof error === "object" && "code" in error && error.code === "ORGANIZE_ROLE_CHANGED" ? "初二配置在处理中改变，后续调用已停止；请重新预览确认。"
            : error && typeof error === "object" && "code" in error && error.code === "ORGANIZE_BUDGET" ? "本次达到100个系统模型请求上限，已完成部分保留，请缩小范围。"
              : "会话内容判断或保存失败；已完成部分保留，请查看初二调用日志。";
      job.result.error = job.error;
      job.stage = job.error;
      operationTrace?.applicationResult(job.result); operationTrace?.fail(error, cancelled);
    } finally {
      for (const id of this.closed ? [] : callIds) systemAiSessions(this.storage).appendOutcome(id, "本次会话自动归类的实际业务结果", job.result);
      this.save(job);
    }
  }
  private apply(job: ConversationOrganizationJob, batch: Item[], candidates: Task[], plan: ConversationGroupingPlan, mode: "auto" | "all"): void {
    const result = job.result;
    const source = new Map(batch.map(item => [item.session.id, item]));
    const refreshed: string[] = [];
    const applied = this.storage.transaction(() => {
      const changes = { createdTasks: [] as ConversationOrganizationResult["createdTasks"], reusedTasks: [] as ConversationOrganizationResult["reusedTasks"], updatedTasks: [] as ConversationOrganizationResult["updatedTasks"], movedSessions: [] as ConversationOrganizationResult["movedSessions"], refused: [] as ConversationOrganizationResult["refused"], unassignedSessions: [] as ConversationOrganizationResult["unassignedSessions"] };
      for (const id of plan.unassigned) changes.unassignedSessions.push({ sessionId: id, reason: "正文中未识别到可确定的具体工作主题。" });
      for (const group of plan.groups) {
        const members = group.sessionIds.flatMap(id => {
          const before = source.get(id)!;
          const current = this.getSession(id);
          const owner = current?.workspaceTaskId ? this.storage.getWandTaskByWorkspaceTaskId(current.workspaceTaskId) : null;
          const currentContainer = current?.workspaceTaskId ? this.storage.getWorkspaceTask(current.workspaceTaskId) : null;
          const directory = current ? currentContainer ? this.taskDirectory(currentContainer) : projectCwdForSession(current) : "";
          if (!current || current.archived || (current.workspaceTaskId ?? null) !== (before.session.workspaceTaskId ?? null)
            || (current.workspaceId ?? null) !== (before.session.workspaceId ?? null) || directory !== before.directory
            || hash(conversationContent(current).userRevision) !== before.userRevision || owner?.status === "archived"
            || mode === "auto" && owner && owner.titleSource !== "auto") {
            changes.refused.push({ id, kind: "session", reason: "会话期间有新输入、归属或人工标题变化，未移动。" });return [];
          }
          return [before];
        });
        if (!members.length) continue;
        let renameAutomatic = false;
        let target = group.existingTaskId ? candidates.find(task => task.container.id === group.existingTaskId) : undefined;
        if (group.existingTaskId && !target) throw new Error("任务不在归类范围。");
        if (!target) {
          // Reuse a whole existing automatic task instead of creating an equivalent empty-shell replacement.
          const sameOwner = members[0]!.session.workspaceTaskId;
          if (sameOwner && members.every(item => item.session.workspaceTaskId === sameOwner)) {
            const existing = candidates.find(task => task.container.id === sameOwner && task.card.titleSource === "auto");
            const membership = existing ? this.storage.listSessionsByWorkspaceTaskSlim(sameOwner) : [];
            if (existing && membership.length === members.length && membership.every(session => members.some(item => item.session.id === session.id))) {
              target = existing; renameAutomatic = true;
            }
          }
        }
        if (target) {
          const current = this.storage.getWandTask(target.card.id);
          if (!current || current.status === "archived" || mode === "auto" && current.titleSource !== "auto"
            || current.title !== target.card.title && !(current.titleSource === "auto" && target.card.titleSource === "auto"
              && !!current.autoTitleSignature && current.autoTitleSignature === target.card.autoTitleSignature)
            || current.description !== target.card.description) {
            changes.refused.push({ id: target.container.id, kind: "task", reason: "目标任务已变化，未覆盖用户的修改。" });continue;
          }
        }
        if (target && renameAutomatic && target.card.title !== group.title) {
          const updated = this.storage.updateWandTask(target.card.id, { title: group.title, titleSource: "auto",
            ...(target.card.description ? {} : { description: group.description }) })!;
          changes.updatedTasks.push({ taskId: target.container.id, previousTitle: redactSystemAiText(target.card.title), title: redactSystemAiText(updated.title) });
          target = { ...target, card: updated };
        }
        let container = target?.container;
        if (!container) {
          const workspaceId = members[0]!.workspaceId ?? this.storage.ensureGlobalWorkspace().id;
          container = this.storage.createWorkspaceTask({ workspaceId, name: group.title,
            ...(members[0]!.workspaceId ? {} : { cwd: members[0]!.directory }), board: { titleSource: "auto", description: group.description } });
          const card = this.storage.getWandTaskByWorkspaceTaskId(container.id)!;
          changes.createdTasks.push({ taskId: container.id, cardId: card.id, title: redactSystemAiText(card.title), sessionCount: members.length });
        } else changes.reusedTasks.push({ taskId: container.id, title: redactSystemAiText(target!.card.title), sessionCount: members.length });
        for (const member of members) {
          if (member.session.workspaceTaskId === container.id) continue;
          this.storage.moveSessionToWorkspaceTask(member.session.id, container.id);
          changes.movedSessions.push({ sessionId: member.session.id, taskId: container.id, taskName: redactSystemAiText(target?.card.title ?? group.title) });
          refreshed.push(member.session.id);
        }
        const touched = new Set([container.id, ...members.flatMap(member => member.session.workspaceTaskId ? [member.session.workspaceTaskId] : [])]);
        for (const id of touched) {
          const card = this.storage.getWandTaskByWorkspaceTaskId(id);
          if (card?.titleSource === "auto") this.storage.updateWandTask(card.id, { autoTitleSignature: taskAutoNameSignature(taskAutoNameSourceText(this.storage, card)) });
        }
      }
      const merged: ConversationOrganizationResult = { ...result,
        createdTasks: [...result.createdTasks, ...changes.createdTasks], updatedTasks: [...result.updatedTasks, ...changes.updatedTasks], reusedTasks: [...result.reusedTasks, ...changes.reusedTasks],
        movedSessions: [...result.movedSessions, ...changes.movedSessions], refused: [...result.refused, ...changes.refused],
        unassignedSessions: [...result.unassignedSessions, ...changes.unassignedSessions] };
      // Membership, newly created tasks and their operation receipt commit together.
      const next = { ...job, result: merged, processedSessions: job.processedSessions + batch.length,
        stage: `已整理 ${job.processedSessions + batch.length}/${job.totalSessions} 个会话` };
      this.storage.saveConversationOrganizationJob(next);
      return next;
    });
    Object.assign(job, applied);
    for (const id of refreshed) {
      try { this.deps.refreshSession?.(id); }
      catch { job.result.refused.push({ id, kind: "session", reason: "归属已保存，运行期刷新失败，请手动刷新。" }); this.save(job); }
    }
  }
}
export function conversationOrganizationService(storage: WandStorage, deps: ConversationOrganizationDependencies): ConversationOrganizationService {
  let service = services.get(storage);
  if (!service) { service = new ConversationOrganizationService(storage, deps); services.set(storage, service); }
  return service;
}
