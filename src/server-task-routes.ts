import type { Express } from "express";
import { dispatchAgentForTask, resolveTaskDispatchTarget } from "./agent-dispatch.js";
import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";
import { cleanupWorktreeSync } from "./git-worktree.js";
import { isRetentionBusy } from "./retention.js";
import { parseWandTaskAgent, type WandStorage } from "./storage.js";
import { defaultMilestoneIdForWrite, resolvedMilestoneFields, scopedMilestoneId } from "./milestone-scope.js";
import { generateWandTaskTitle, provisionalTaskTitleFromDescription, TASK_TITLE_MAX_LENGTH } from "./task-title.js";
import { recordIterationPromptForTask } from "./iteration-log.js";
import type { QuickCommitAiOptions } from "./git-quick-commit.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import type { SessionRegistry } from "./session-registry.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { AiTeamRunner } from "./ai-team-runner.js";
import { memberAgents } from "./ai-team-types.js";
import { selectEmployeeCandidate } from "./silicon-employee-dispatch.js";
import { defaultRoleForCli } from "./default-employee.js";
import type { TaskExecutionSubject, WandTaskAgent, WandTaskAgentEngine, WandTaskAgentKind, WandTaskAgentMode, WandTaskPriority, WandTaskStatus, WandTaskTitleSource } from "./task-types.js";
import { DEFAULT_WAND_TASK_AGENT_KIND, DEFAULT_WAND_TASK_AGENT_MODE, DEFAULT_WAND_TASK_PRIORITY, isWandTaskAgentEngine, isWandTaskAgentKind, isWandTaskAgentMode, normalizeWandTaskAgentMode, WAND_MILESTONE_NAME_MAX_LENGTH } from "./task-types.js";
import { isAutoNameableBoardTask, taskAutoNameSignature, taskAutoNameSourceText } from "./wand-task-sync.js";
import type { SessionSnapshot, WandConfig } from "./types.js";
import { isSessionProvider } from "./session-provider.js";
import { isThinkingEffort } from "./structured-provider-common.js";

const STATUSES = new Set<WandTaskStatus>(["todo", "doing", "done", "archived"]);
const PRIORITIES = new Set<WandTaskPriority>(["none", "low", "medium", "high", "urgent"]);

const TASK_BOARD_LAST_AGENT_KEY = "pref:taskBoardLastAgent";

function defaultTaskBoardAgent(): WandTaskAgent {
  return { provider: "claude", model: "default", thinkingEffort: "off", mode: DEFAULT_WAND_TASK_AGENT_MODE, kind: DEFAULT_WAND_TASK_AGENT_KIND };
}

/** 任务面板上次选用的 CLI 工具 / 模型 / 思考深度；从未保存过时回落到 Claude 默认。 */
export function readTaskBoardLastAgent(storage: WandStorage): WandTaskAgent {
  const raw = storage.getPreference<unknown>(TASK_BOARD_LAST_AGENT_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultTaskBoardAgent();
  try {
    return parseTaskAgent(raw) ?? defaultTaskBoardAgent();
  } catch {
    return defaultTaskBoardAgent();
  }
}

export function writeTaskBoardLastAgent(storage: WandStorage, agent: WandTaskAgent): void {
  storage.setPreference(TASK_BOARD_LAST_AGENT_KEY, {
    provider: agent.provider,
    model: agent.model,
    thinkingEffort: agent.thinkingEffort,
    mode: agent.mode,
    kind: agent.kind,
    ...(agent.engine ? { engine: agent.engine } : {}),
  });
}

export interface TaskRouteDependencies {
  storage: WandStorage;
  sessions?: SessionRegistry;
  structured?: StructuredSessionManager;
  /** PTY 会话创建入口；派发 `kind: "pty"` 的任务时使用。测试里可换成同步桩。 */
  processes?: ProcessManager;
  config?: WandConfig;
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
  aiTeams?: AiTeamRunner;
  /** 可注入的任务标题生成器；测试里换成同步桩，避免真的起 CLI。 */
  generateTitle?: typeof generateWandTaskTitle;
}

function parseExecutionSubject(storage: WandStorage, value: unknown): TaskExecutionSubject | null {
  if (value === null) return null;
  const body = bodyObject(value);
  const type = text(body.type);
  const id = text(body.id);
  if (!id) throw new Error("请选择执行对象。");
  if (type === "employee") {
    const employee = storage.getSiliconEmployee(id);
    if (!employee || employee.archivedAt) throw new Error("硅基员工不存在或已归档。");
    return { type, id };
  }
  if (type === "team") {
    if (!storage.getAiTeam(id)) throw new Error("AI 团队不存在。");
    return { type, id };
  }
  if (type === "cli") {
    if (!isSessionProvider(id)) throw new Error("请选择有效的 CLI 工具。");
    return { type, id };
  }
  throw new Error("执行对象类型无效。");
}

function preferredAgentForSubject(storage: WandStorage, subject: TaskExecutionSubject): WandTaskAgent | null {
  if (subject.type === "employee") return storage.getSiliconEmployee(subject.id)?.agents[0] ?? null;
  if (subject.type === "team") {
    const team = storage.getAiTeam(subject.id);
    const member = team?.members.find((entry) => entry.isLeader) ?? team?.members[0];
    return member ? memberAgents(member)[0] ?? null : null;
  }
  return null;
}

function cliAgentForSubject(subject: TaskExecutionSubject, current?: WandTaskAgent | null): WandTaskAgent {
  return parseTaskAgent({
    ...(current?.provider === subject.id ? current : defaultTaskBoardAgent()),
    provider: subject.id,
  })!;
}

function dateValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error("截止日期必须使用 YYYY-MM-DD 格式。");
  }
  return value.trim();
}

function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

/** 新认领只能挂到同项目且正在处理的任务；历史归属在父任务完成后仍保留。 */
export function parentTaskIdFrom(
  storage: WandStorage,
  value: unknown,
  workspaceId: string | null,
  childId: string | null = null,
  existingParentId: string | null = null,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("父任务无效。");
  const parentId = value.trim();
  const parent = storage.getWandTask(parentId);
  if (!parent) throw new Error("父任务不存在。");
  if (parent.workspaceId !== workspaceId) throw new Error("父任务必须与子任务属于同一项目目录。");
  if (parent.status !== "doing" && parentId !== existingParentId) {
    throw new Error("只能认领到正在处理的父任务。");
  }
  // 不允许自己做父任务，也不允许把祖先接到后代下。
  const visited = new Set<string>();
  let ancestorId: string | null = parentId;
  while (ancestorId) {
    if (ancestorId === childId || visited.has(ancestorId)) throw new Error("父任务不能形成循环。");
    visited.add(ancestorId);
    ancestorId = storage.getWandTask(ancestorId)?.parentTaskId ?? null;
  }
  return parentId;
}

function assertTaskWorkspaceMove(storage: WandStorage, taskId: string, workspaceId: string | null): void {
  if (storage.listWandTasks().some((task) => task.parentTaskId === taskId && task.workspaceId !== workspaceId)) {
    throw new Error("请先将子任务解除归属，再移动父任务的项目目录。");
  }
}

/** 里程碑名：必填、去首尾空白、限长。 */
function milestoneNameFrom(value: unknown): string {
  const name = text(value).slice(0, WAND_MILESTONE_NAME_MAX_LENGTH);
  if (!name) throw new Error("请填写里程碑名称。");
  return name;
}

/** 只有已存在的里程碑才能挂到任务上；null / 空串表示解绑。 */
function milestoneIdFrom(storage: WandStorage, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = text(value);
  if (!id) return null;
  if (!storage.getWandMilestone(id)) throw new Error("未找到该里程碑。");
  return id;
}

/** 新建里程碑时归属的工作区；null 表示全局（未指定项目）。 */
function milestoneWorkspaceIdFrom(storage: WandStorage, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const workspaceId = text(value);
  if (!workspaceId) return null;
  if (!storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
  return workspaceId;
}

/**
 * 任务派发配置：provider / model / thinkingEffort 必须合法；mode 缺省时用 `fallbackMode`。
 * 老客户端（Android / iOS 尚未发 mode）不传 mode，PATCH / dispatch 时传任务当前值，
 * 避免把用户在 Web 上选的工作模式悄悄复位成标准。
 */
export function parseTaskAgent(
  value: unknown,
  fallbackMode: WandTaskAgentMode = DEFAULT_WAND_TASK_AGENT_MODE,
  fallbackKind: WandTaskAgentKind = DEFAULT_WAND_TASK_AGENT_KIND,
): WandTaskAgent | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent 配置必须是对象。");
  const body = value as Record<string, unknown>;
  const provider = text(body.provider);
  if (!isSessionProvider(provider)) throw new Error("请选择有效的 CLI 工具。");
  const model = text(body.model) || "default";
  if (model.length > 128) throw new Error("模型名称过长。");
  const thinkingEffort = text(body.thinkingEffort) || "off";
  if (!isThinkingEffort(thinkingEffort)) throw new Error("思考深度无效。");
  const rawMode = body.mode === undefined || body.mode === null || body.mode === "" ? fallbackMode : body.mode;
  if (!isWandTaskAgentMode(rawMode)) throw new Error("工作模式无效。");
  // Codex 之类只认一种模式的 provider 在这里夹到有效值，落库值与实际执行保持一致。
  const mode = normalizeWandTaskAgentMode(provider, rawMode);
  // kind 与 mode 同样兼容老客户端：不传就沿用任务当前值，避免把 PTY 悄悄复位成结构化。
  const rawKind = body.kind === undefined || body.kind === null || body.kind === "" ? fallbackKind : body.kind;
  if (!isWandTaskAgentKind(rawKind)) throw new Error("会话形态无效。");
  const rawEngine = body.engine === undefined || body.engine === null || body.engine === "" ? "cli" : body.engine;
  if (!isWandTaskAgentEngine(rawEngine)) throw new Error("执行引擎无效。");
  if (rawEngine === "sdk" && (provider !== "pi" || rawKind !== "structured")) {
    throw new Error("Wand Agent 仅支持结构化会话。");
  }
  const engine: WandTaskAgentEngine | undefined = rawEngine === "sdk" ? rawEngine : undefined;
  return { provider, model, thinkingEffort, mode, kind: rawKind, ...(engine ? { engine } : {}) };
}

interface TaskDtoDeps {
  storage: WandStorage;
  sessions?: SessionRegistry;
}

function taskDto({ storage, sessions }: TaskDtoDeps, task: ReturnType<WandStorage["getWandTask"]>) {
  if (!task) return null;
  const workspace = task.workspaceId ? storage.getWorkspace(task.workspaceId) : null;
  const sessionIds = storage.listWandTaskSessionIds(task.id);
  const milestone = resolvedMilestoneFields(storage, task.milestoneId);
  return {
    ...task,
    sessionIds,
    sessions: sessionIds.flatMap((id) => {
      const session = sessions?.getLatest(id) ?? storage.getSession(id);
      return session ? [taskSessionSummary(session)] : [];
    }),
    workspace: workspace
      ? { id: workspace.id, name: workspace.name, cwd: workspace.cwd }
      : null,
    // 卡片上要显示迭代名字，直接在这里解出，免去前端再查一次列表。
    // 任务没有单独指定迭代时给的就是默认迭代（id 与名字成对返回）。
    milestoneId: milestone.milestoneId,
    milestone: milestone.milestone,
  };
}

function taskSessionSummary(session: SessionSnapshot) {
  return {
    id: session.id,
    provider: session.provider ?? "",
    sessionKind: session.sessionKind ?? "",
    title: session.title || session.description || session.command,
    status: session.status,
    cwd: session.cwd,
    model: session.selectedModel || session.structuredState?.model || "",
    thinkingEffort: session.thinkingEffort || "off",
    // 会话实际跑的执行模式；旧会话没有该字段时留空，前端回落到任务上的配置。
    mode: session.mode || "",
    // 执行引擎：core = Wand Agent（进程内 SDK）；pi 会话没跑过时按 CLI 读。
    engine: session.provider === "pi" ? (session.structuredState?.engine === "core" ? "sdk" : "cli") : undefined,
    employeeId: session.employeeId,
    employeeName: session.employeeName,
    employeeAvatar: session.employeeAvatar,
  };
}

/**
 * 用户没写标题时，先用描述/会话内容当占位标题，再由后台模型总结一个更好的。
 * 全程不阻塞创建请求：失败只是保留占位标题，不返回错误、也不覆盖用户后来改的标题。
 * 多次总结会排队而不是丢弃，保证每张卡片最终都会拿到标题。
 */
let titleGenerationChain: Promise<void> = Promise.resolve();

function scheduleWandTaskTitleGeneration(
  storage: WandStorage,
  taskId: string,
  source: string,
  signature: string,
  options: AutoTaskTitleOptions,
): void {
  const generateTitle = options.generateTitle ?? generateWandTaskTitle;
  const cwd = options.cwd || options.config?.defaultCwd || process.cwd();
  const run = async (): Promise<void> => {
    try {
      const title = await generateTitle(source, cwd, options.config?.language ?? "", taskTitleAiOptions(options.config, storage, options.free));
      const current = storage.getWandTask(taskId);
      // 用户已经自己写了标题（原生端 / 面板编辑）就不要覆盖。
      if (!current || current.titleSource !== "auto") return;
      // 命名输入已经变了（新增会话 / 会话内容更新）：这次是过期结果，交给下一轮。
      if (current.autoTitleSignature !== signature) return;
      const clipped = title.slice(0, TASK_TITLE_MAX_LENGTH);
      if (!clipped || clipped === current.title) return;
      storage.updateWandTask(taskId, { title: clipped });
    } catch (error) {
      console.error(`[WandTask] Failed to auto-generate title for ${taskId}:`, getErrorMessage(error));
    }
  };
  titleGenerationChain = titleGenerationChain.then(run, run);
}

/** 等待排队中的标题生成全部结束；只有测试用，避免用例轮询。 */
export function whenWandTaskTitlesSettled(): Promise<void> {
  return titleGenerationChain;
}

export interface AutoTaskTitleOptions {
  config?: WandConfig;
  free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
  /** 可注入的标题生成器；测试里换成同步桩，避免真的起 CLI。 */
  generateTitle?: typeof generateWandTaskTitle;
  /** 未从任务所属工作区解析到目录时的兜底 cwd。 */
  cwd?: string;
}

/**
 * 扫描标题仍可自动命名的看板任务（titleSource=auto，或仍是占位名的历史卡片）：
 * 先用任务描述 + 所有绑定会话的内容立即改掉占位名，再交给后台模型总结更贴切的标题。
 * 同一个输入指纹只处理一次：内容没变就跳过，也避免自动标题与模型结果来回震荡。
 * 用户建任务时写了名字、或事后改过名（titleSource=user 且不是占位名）的任务永不进入这里。
 */
export function refreshAutoBoardTaskTitles(storage: WandStorage, options: AutoTaskTitleOptions = {}): void {
  for (const card of storage.listWandTasks()) {
    if (!isAutoNameableBoardTask(card)) continue;
    const source = taskAutoNameSourceText(storage, card);
    if (!source) continue;
    const signature = taskAutoNameSignature(source);
    if (card.autoTitleSignature === signature) continue;
    const provisional = provisionalTaskTitleFromDescription(source);
    storage.updateWandTask(card.id, {
      titleSource: "auto",
      autoTitleSignature: signature,
      ...(provisional && provisional !== card.title ? { title: provisional } : {}),
    });
    // 未启用模型（如部分只验证占位改名的单测）时只保留立即生效的占位标题。
    if (!options.generateTitle && !options.config) continue;
    const cwd = options.cwd
      || (card.workspaceId ? storage.getWorkspace(card.workspaceId)?.cwd : undefined);
    scheduleWandTaskTitleGeneration(storage, card.id, source, signature, {
      cwd,
      config: options.config,
      generateTitle: options.generateTitle,
      free: options.free,
    });
  }
}

/** 自动生成标题没有会话上下文，按「默认 provider + 默认模型」解析，与提示词优化一致。 */
function taskTitleAiOptions(config?: WandConfig, storage?: WandStorage, free?: AutoTaskTitleOptions["free"]): QuickCommitAiOptions {
  if (!config) return {};
  const provider = config.defaultProvider ?? "claude";
  const defaultSession = {
    provider,
    structuredState: undefined,
    runner: undefined,
    command: provider === "qoder" ? "qodercli" : provider,
    selectedModel: null,
    thinkingEffort: config.defaultThinkingEffort,
  };
  return resolveSystemAiContext(defaultSession, config, storage?.getSystemSiliconEmployee() ?? null, free);
}

export function registerTaskRoutes(app: Express, deps: TaskRouteDependencies): void {
  const { storage, sessions, structured, processes, config, aiTeams } = deps;
  const dto = (task: ReturnType<WandStorage["getWandTask"]>) => taskDto(deps, task);

  app.get("/api/wand-tasks", (req, res) => {
    try {
      // 侧栏建的任务 / 后续新增的会话都会在这里补上自动标题。
      refreshAutoBoardTaskTitles(storage, { config, generateTitle: deps.generateTitle, free: deps.free });
    } catch (error) {
      console.error("[WandTask] Failed to refresh auto task titles:", getErrorMessage(error));
    }
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    // 数组顺序即展示顺序：created_at 倒序，新创建的在上面。
    res.json(storage.listWandTasks(workspaceId).map((task) => dto(task)));
  });
  app.get("/api/wand-task-agent-defaults", (_req, res) => {
    res.json(readTaskBoardLastAgent(storage));
  });
  // ── 迭代（里程碑）：归属工作区，任务面板的「新建任务」按工作区过滤 ──
  app.get("/api/wand-milestones", (req, res) => {
    // 不传 workspaceId 返回全部；传了就只给「该工作区 + 全局」的迭代。
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    // 默认迭代是惰性创建的：列表是它的第一个真实读取点，在这里保证它一定存在。
    storage.ensureDefaultWandMilestone();
    const counts = storage.countWandTasksByMilestone();
    res.json({
      milestones: storage.listWandMilestones(workspaceId).map((milestone) => ({
        ...milestone,
        taskCount: counts[milestone.id] ?? 0,
      })),
    });
  });
  app.post("/api/wand-milestones", (req, res) => {
    try {
      const body = bodyObject(req.body);
      const name = milestoneNameFrom(body.name);
      const workspaceId = milestoneWorkspaceIdFrom(storage, body.workspaceId);
      // 重名只在「同一个工作区可见的里程碑」里查：不同工作区可以各有同名迭代。
      const duplicate = storage.listWandMilestones(workspaceId)
        .find((milestone) => milestone.name.toLowerCase() === name.toLowerCase());
      if (duplicate) throw new Error(`里程碑「${duplicate.name}」已存在。`);
      const created = storage.createWandMilestone({ name, dueDate: dateValue(body.dueDate) ?? null, workspaceId });
      res.status(201).json({ ...created, taskCount: 0 });
    } catch (error) {
      sendRouteError(res, error, "无法创建里程碑。");
    }
  });
  app.patch("/api/wand-milestones/:id", (req, res) => {
    try {
      const body = bodyObject(req.body);
      const current = storage.getWandMilestone(req.params.id);
      if (!current) {
        res.status(404).json({ error: "未找到该里程碑。" });
        return;
      }
      const patch: { name?: string; dueDate?: string | null; workspaceId?: string | null } = {};
      if (body.name !== undefined) {
        const name = milestoneNameFrom(body.name);
        const duplicate = storage.listWandMilestones(current.workspaceId)
          .find((milestone) => milestone.id !== current.id && milestone.name.toLowerCase() === name.toLowerCase());
        if (duplicate) throw new Error(`里程碑「${duplicate.name}」已存在。`);
        patch.name = name;
      }
      if (body.workspaceId !== undefined) {
        // 允许改挂工作区（例如新建任务时目录对应的项目还没建，提交后再绑上）。
        const workspaceId = milestoneWorkspaceIdFrom(storage, body.workspaceId);
        const duplicate = storage.listWandMilestones(workspaceId)
          .find((milestone) => milestone.id !== current.id && milestone.name.toLowerCase() === current.name.toLowerCase());
        if (duplicate) throw new Error(`里程碑「${duplicate.name}」已存在。`);
        patch.workspaceId = workspaceId;
      }
      if (body.dueDate !== undefined) patch.dueDate = dateValue(body.dueDate) ?? null;
      const updated = storage.updateWandMilestone(current.id, patch);
      res.json({ ...updated, taskCount: storage.countWandTasksByMilestone()[current.id] ?? 0 });
    } catch (error) {
      sendRouteError(res, error, "无法更新里程碑。");
    }
  });
  app.delete("/api/wand-milestones/:id", (req, res) => {
    const current = storage.getWandMilestone(req.params.id);
    // 默认迭代是所有任务的兜底归属，删了就再没有地方接「没选迭代」的任务。
    if (current?.isDefault) {
      res.status(400).json({ error: "默认迭代不能删除，可以改成你自己习惯的名字。" });
      return;
    }
    // 只解绑任务，不删任务；已经删过的 id 幂等返回 ok。
    storage.deleteWandMilestone(req.params.id);
    res.json({ ok: true });
  });
  app.put("/api/wand-task-agent-defaults", (req, res) => {
    try {
      // 老客户端（尚未发 mode）不传 mode：沿用已保存的模式，而不是把全局默认复位成标准。
      const agent = parseTaskAgent(req.body, readTaskBoardLastAgent(storage).mode);
      if (!agent) throw new Error("请选择有效的 CLI 工具。");
      writeTaskBoardLastAgent(storage, agent);
      res.json(agent);
    } catch (error) {
      sendRouteError(res, error, "无法保存 Agent 默认选项。");
    }
  });
  app.post("/api/wand-tasks", (req, res) => {
    try {
      const body = bodyObject(req.body);
      const requestedParent = body.parentTaskId == null ? null : storage.getWandTask(text(body.parentTaskId));
      const workspaceId = body.workspaceId === undefined && requestedParent
        ? requestedParent.workspaceId
        : body.workspaceId === null ? null : text(body.workspaceId) || null;
      if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
      const parentTaskId = parentTaskIdFrom(storage, body.parentTaskId ?? null, workspaceId);
      const description = text(body.description);
      // 标题是可选字段：用户不写就先用描述首行占位，再由模型在后台覆盖。
      const providedTitle = text(body.title);
      if (!providedTitle && !description) throw new Error("请填写任务标题或任务描述。");
      const titleSource: WandTaskTitleSource = providedTitle ? "user" : "auto";
      const title = providedTitle || provisionalTaskTitleFromDescription(description) || "新建任务";
      const status = STATUSES.has(body.status as WandTaskStatus) ? body.status as WandTaskStatus : "todo";
      const priority = PRIORITIES.has(body.priority as WandTaskPriority) ? body.priority as WandTaskPriority : DEFAULT_WAND_TASK_PRIORITY;
      const agent = body.agent === undefined ? null : parseTaskAgent(body.agent);
      const executionSubject = body.executionSubject === undefined
        ? agent ? { type: "cli" as const, id: agent.provider } : null
        : parseExecutionSubject(storage, body.executionSubject);
      if (executionSubject?.type === "cli" && agent && agent.provider !== executionSubject.id) {
        throw new Error("CLI 执行对象与工具配置不一致。");
      }
      if (executionSubject?.type !== "cli" && executionSubject && agent?.kind === "pty") {
        throw new Error("PTY 只能选择 CLI 工具。");
      }
      const assignedAgent = executionSubject && executionSubject.type !== "cli"
        ? preferredAgentForSubject(storage, executionSubject)
        : executionSubject?.type === "cli" ? agent ?? cliAgentForSubject(executionSubject) : agent;
      const labels = labelsFrom(body.labels);
      const dueDate = dateValue(body.dueDate) ?? null;
      // 没选迭代就落到默认迭代：每个任务都属于一个迭代。
      const requestedMilestoneId = milestoneIdFrom(storage, body.milestoneId) ?? defaultMilestoneIdForWrite(storage);
      const milestoneId = scopedMilestoneId(storage, requestedMilestoneId, workspaceId)
        ?? defaultMilestoneIdForWrite(storage);
      const task = storage.createWandTask({
        workspaceId,
        parentTaskId,
        title,
        titleSource,
        description,
        status,
        priority,
        labels,
        dueDate,
        milestoneId,
        agent: assignedAgent,
        executionSubject,
      });
      // Task execution settings stay local unless the caller explicitly saves future defaults.
      if (body.rememberAgentDefaults === true && agent) writeTaskBoardLastAgent(storage, agent);
      if (titleSource === "auto") {
        refreshAutoBoardTaskTitles(storage, {
          cwd: workspaceId ? storage.getWorkspace(workspaceId)?.cwd : undefined,
          config,
          generateTitle: deps.generateTitle,
          free: deps.free,
        });
      }
      res.status(201).json(dto(storage.getWandTask(task.id) ?? task));
    } catch (error) {
      sendRouteError(res, error, "无法创建任务。");
    }
  });
  app.patch("/api/wand-tasks/:id", (req, res) => {
    try {
      const body = bodyObject(req.body);
      const currentTask = storage.getWandTask(req.params.id);
      if (!currentTask) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      const patch: Parameters<WandStorage["updateWandTask"]>[1] = {};
      if (body.title !== undefined) {
        // 显式改标题（包括原生端的可编辑标题框）都算用户自己写的。
        const value = text(body.title);
        if (!value) throw new Error("任务标题不能为空。");
        patch.title = value;
        patch.titleSource = "user";
      }
      if (body.description !== undefined) patch.description = text(body.description);
      if (body.status !== undefined) {
        if (!STATUSES.has(body.status as WandTaskStatus)) throw new Error("任务状态无效。");
        patch.status = body.status as WandTaskStatus;
      }
      if (body.priority !== undefined) {
        if (!PRIORITIES.has(body.priority as WandTaskPriority)) throw new Error("任务优先级无效。");
        patch.priority = body.priority as WandTaskPriority;
      }
      if (body.labels !== undefined) patch.labels = labelsFrom(body.labels);
      if (body.dueDate !== undefined) patch.dueDate = dateValue(body.dueDate) ?? null;
      if (body.milestoneId !== undefined) {
        // 清空迭代等于回到默认迭代（原生端的「清除」按钮也走这里）。
        patch.milestoneId = milestoneIdFrom(storage, body.milestoneId) ?? defaultMilestoneIdForWrite(storage);
      }
      if (body.workspaceId !== undefined) {
        const workspaceId = body.workspaceId === null ? null : text(body.workspaceId);
        if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
        patch.workspaceId = workspaceId || null;
        // 换项目后原迭代不再属于新工作区就一并收敛；移动端只 PATCH workspaceId，不会自己清。
        const milestoneId = body.milestoneId !== undefined
          ? patch.milestoneId
          : storage.getWandTask(req.params.id)?.milestoneId ?? null;
        patch.milestoneId = scopedMilestoneId(storage, milestoneId, patch.workspaceId)
          ?? defaultMilestoneIdForWrite(storage);
      }
      if (body.parentTaskId !== undefined || body.workspaceId !== undefined) {
        const workspaceId = patch.workspaceId === undefined ? currentTask.workspaceId : patch.workspaceId;
        patch.parentTaskId = parentTaskIdFrom(
          storage, body.parentTaskId === undefined ? currentTask.parentTaskId : body.parentTaskId,
          workspaceId, currentTask.id, currentTask.parentTaskId,
        );
        if (workspaceId !== currentTask.workspaceId) assertTaskWorkspaceMove(storage, currentTask.id, workspaceId);
      }
      if (body.agent !== undefined) {
        // 老客户端不传 mode / kind：沿用任务当前值，而不是复位成标准 / 结构化。
        patch.agent = parseTaskAgent(body.agent, currentTask.agent?.mode, currentTask.agent?.kind);
        if (body.executionSubject === undefined && patch.agent) {
          patch.executionSubject = { type: "cli", id: patch.agent.provider };
        }
      }
      if (body.executionSubject !== undefined) {
        patch.executionSubject = parseExecutionSubject(storage, body.executionSubject);
        if (patch.executionSubject?.type === "cli" && patch.agent
          && patch.agent.provider !== patch.executionSubject.id) {
          throw new Error("CLI 执行对象与工具配置不一致。");
        }
        if (patch.executionSubject?.type === "cli" && !patch.agent) {
          patch.agent = cliAgentForSubject(patch.executionSubject, currentTask.agent);
        }
        if (patch.executionSubject && patch.executionSubject.type !== "cli") {
          if (patch.agent?.kind === "pty") throw new Error("PTY 只能选择 CLI 工具。");
          patch.agent = preferredAgentForSubject(storage, patch.executionSubject);
        }
      }
      if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
        patch.sortOrder = Math.floor(Number(body.sortOrder));
      }
      const task = storage.updateWandTask(req.params.id, patch);
      if (!task) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      if (body.rememberAgentDefaults === true && patch.agent) writeTaskBoardLastAgent(storage, patch.agent);
      res.json(dto(storage.getWandTask(task.id) ?? task));
    } catch (error) {
      sendRouteError(res, error, "无法更新任务。");
    }
  });
  /**
   * 清空归档目录：硬删除所有 archived 卡片（可按项目范围）。
   * 名下会话还在处理的卡片跳过，不静默打断执行；其余按单卡删除的同一套归属清理。
   * 必须注册在 `/api/wand-tasks/:id` 之前，否则 "archived" 会被当成任务 id。
   */
  app.delete("/api/wand-tasks/archived", (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" && req.query.workspaceId
        ? req.query.workspaceId
        : undefined;
      const archived = storage.listWandTasks(workspaceId).filter((task) => task.status === "archived");
      const busy = new Set(sessions?.listSlim().filter(isRetentionBusy).map((session) => session.id) ?? []);
      const deletable: string[] = [];
      let skipped = 0;
      for (const task of archived) {
        const bound = storage.listWandTaskSessionIds(task.id);
        if (bound.some((sessionId) => busy.has(sessionId))) {
          skipped += 1;
          continue;
        }
        const container = task.workspaceTaskId ? storage.getWorkspaceTask(task.workspaceTaskId) : null;
        if (container?.worktree) {
          try { cleanupWorktreeSync(container.worktree); } catch { /* worktree 可能已被手动删除 */ }
        }
        deletable.push(task.id);
      }
      const deleted = storage.deleteWandTasks(deletable);
      res.json({ ok: true, deleted: deleted.length, skipped });
    } catch (error) {
      sendRouteError(res, error, "无法清空归档任务。");
    }
  });
  app.delete("/api/wand-tasks/:id", (req, res) => {
    const archived = storage.updateWandTask(req.params.id, { status: "archived" });
    if (!archived) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    res.json({ ok: true, ...dto(archived) });
  });
  app.post("/api/wand-tasks/:id/sessions", (req, res) => {
    try {
      const sessionId = text(bodyObject(req.body).sessionId);
      if (!sessionId) throw new Error("缺少 sessionId。");
      if (sessions && !sessions.get(sessionId)) throw new Error("未找到该会话。");
      const card = storage.getWandTask(req.params.id);
      if (!card) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      storage.bindWandTaskSession(card.id, sessionId);
      sessions?.refreshSessionWorkspace(sessionId);
      res.status(201).json(dto(storage.getWandTask(req.params.id)));
    } catch (error) {
      sendRouteError(res, error, "无法绑定会话。");
    }
  });
  app.delete("/api/wand-tasks/:id/sessions/:sessionId", (req, res) => {
    const card = storage.getWandTask(req.params.id);
    const session = storage.getSession(req.params.sessionId);
    if (card?.workspaceTaskId && session?.workspaceTaskId === card.workspaceTaskId) {
      storage.moveSessionToWorkspaceTask(session.id, null);
      sessions?.refreshSessionWorkspace(session.id);
    } else {
      storage.unbindWandTaskSession(req.params.id, req.params.sessionId);
    }
    res.json({ ok: true });
  });

  /**
   * 用选定的 CLI 工具开一个会话（`agent.kind` 为 structured 时是结构化对话，pty 时是原始
   * CLI 终端），把这次派发的 prompt 作为首条消息 / 初始输入，并把会话绑定回该任务。
   * cwd 取任务所属项目目录；未指定项目时用全局默认目录。
   */
  app.post("/api/wand-tasks/:id/dispatch", asyncRoute(async (req, res) => {
    try {
      let task = storage.getWandTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      if (!config) throw new Error("当前服务未启用派发，无法派发 Agent。");
      const body = bodyObject(req.body);
      const subject = body.subject === undefined
        ? body.agent !== undefined ? null : task.executionSubject ?? null
        : parseExecutionSubject(storage, body.subject);
      if ((subject?.type === "employee" || subject?.type === "team")
        && (body.kind === "pty" || (body.agent && bodyObject(body.agent).kind === "pty"))) {
        throw new Error("PTY 只能选择 CLI 工具。");
      }
      const requestedPrompt = text(body.prompt);
      const existingSessions = storage.listWandTaskSessionIds(task.id).length;
      if (existingSessions > 0 && !requestedPrompt) throw new Error("请输入提示词。");
      const prompt = requestedPrompt || task.description.trim() || task.title || "执行此任务";
      if (subject?.type === "team") {
        if (!aiTeams) throw new Error("当前服务未启用 AI 团队。");
        const team = storage.getAiTeam(subject.id);
        if (!team) throw new Error("AI 团队不存在。");
        if (body.workspaceId !== undefined) {
          const workspaceId = body.workspaceId === null ? null : text(body.workspaceId) || null;
          if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
          parentTaskIdFrom(storage, task.parentTaskId, workspaceId, task.id, task.parentTaskId);
          if (workspaceId !== task.workspaceId) assertTaskWorkspaceMove(storage, task.id, workspaceId);
          task = storage.updateWandTask(task.id, { workspaceId }) ?? task;
        }
        const target = resolveTaskDispatchTarget({ storage, config }, task);
        const detail = await aiTeams.start({ teamId: team.id, taskId: task.id, note: prompt });
        const preferredMember = team.members.find((member) => member.isLeader) ?? team.members[0];
        const preferredAgent = preferredMember ? memberAgents(preferredMember)[0] ?? null : null;
        storage.updateWandTask(task.id, {
          executionSubject: subject,
          agent: preferredAgent,
          status: task.status === "todo" ? "doing" : task.status,
        });
        recordIterationPromptForTask(storage, {
          sessionId: detail.run.chatSessionId ?? undefined,
          cwd: target.cwd,
          workspaceId: target.workspaceId,
          milestoneId: task.milestoneId,
          taskId: task.id,
          title: task.title,
          detail: task.description || prompt,
          source: "dispatch",
        });
        res.status(202).json({
          ok: true,
          taskId: task.id,
          subject,
          teamRun: detail,
          session: detail.run.chatSessionId ? { id: detail.run.chatSessionId, sessionKind: "structured" } : null,
        });
        return;
      }
      const employee = subject?.type === "employee" ? storage.getSiliconEmployee(subject.id) : null;
      if (subject?.type === "employee" && (!employee || employee.archivedAt)) {
        throw new Error("硅基员工不存在或已归档。");
      }
      const selected = employee ? selectEmployeeCandidate(employee) : null;
      const cliDefault = subject?.type === "cli"
        ? parseTaskAgent({ ...cliAgentForSubject(subject, task.agent), ...(body.kind === "pty" ? { kind: "pty" } : {}) })
        : null;
      const fallbackCandidate = !subject && body.agent === undefined && !task.agent
        && !body.provider ? selectEmployeeCandidate(defaultRoleForCli(storage, config.defaultProvider)).agent : null;
      const fallbackAgent = fallbackCandidate && body.kind === "pty"
        ? { ...fallbackCandidate, kind: "pty" as const } : fallbackCandidate;
      const agent = selected?.agent ?? (body.agent === undefined
        ? cliDefault ?? task.agent ?? fallbackAgent ?? parseWandTaskAgent(JSON.stringify(body))
        : parseTaskAgent(body.agent, task.agent?.mode, task.agent?.kind));
      if (!agent) throw new Error("请先为该任务选择 CLI 工具。");
      if (subject?.type === "cli" && agent.provider !== subject.id) {
        throw new Error("CLI 执行对象与工具配置不一致。");
      }
      if (agent.kind === "structured" && !structured) throw new Error("当前服务未启用结构化会话，无法派发 Agent。");
      if (agent.kind === "pty" && !processes) throw new Error("当前服务未启用终端会话，无法派发 Agent。");
      if (body.workspaceId !== undefined) {
        const workspaceId = body.workspaceId === null ? null : text(body.workspaceId) || null;
        if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
        parentTaskIdFrom(storage, task.parentTaskId, workspaceId, task.id, task.parentTaskId);
        if (workspaceId !== task.workspaceId) assertTaskWorkspaceMove(storage, task.id, workspaceId);
        task = storage.updateWandTask(task.id, { workspaceId }) ?? task;
      }
      const { session, cwd, workspaceId } = await dispatchAgentForTask(
        { storage, config, structured: structured ?? null, processes: processes ?? null },
        { task, agent, prompt, automationId: `wand-task:${task.id}`,
          systemPrompt: employee?.prompt, employee: employee ?? undefined,
          employeeCandidateIndex: selected?.index },
      );
      task = storage.getWandTask(task.id)!;
      const usedSubject = subject ?? { type: "cli" as const, id: agent.provider };
      storage.updateWandTask(task.id, {
        agent,
        executionSubject: usedSubject,
        status: task.status === "todo" ? "doing" : task.status,
      });
      if (body.rememberAgentDefaults === true && !employee) writeTaskBoardLastAgent(storage, agent);
      // 派发也算一轮迭代里的改动意图：直接把任务的标题 / 描述记进迭代记录。
      recordIterationPromptForTask(storage, {
        sessionId: session.id,
        cwd,
        workspaceId,
        milestoneId: task.milestoneId,
        taskId: task.id,
        title: task.title,
        detail: task.description || prompt,
        source: "dispatch",
      });
      res.status(202).json({
        ok: true,
        taskId: task.id,
        subject: usedSubject,
        session: {
          id: session.id,
          provider: session.provider,
          sessionKind: session.sessionKind ?? "pty",
          model: session.selectedModel,
          thinkingEffort: session.thinkingEffort,
          mode: session.mode,
          cwd: session.cwd,
          employeeId: session.employeeId,
          employeeName: session.employeeName,
          employeeAvatar: session.employeeAvatar,
          employeeCandidateIndex: session.employeeCandidateIndex,
        },
      });
    } catch (error) {
      sendRouteError(res, error, "无法派发 Agent。");
    }
  }));

  app.get("/api/wand-tasks/:id", asyncRoute(async (req, res) => {
    const task = dto(storage.getWandTask(req.params.id));
    if (!task) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    res.json(task);
  }));
}
