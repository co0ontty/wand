import type { Express, RequestHandler, Response } from "express";
import { getDefaultModelForProvider } from "./config.js";
import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import { parseWandTaskAgent, type WandStorage } from "./storage.js";
import { generateWandTaskTitle, provisionalTaskTitleFromDescription, TASK_TITLE_MAX_LENGTH } from "./task-title.js";
import type { QuickCommitAiOptions } from "./git-quick-commit.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import type { SessionRegistry } from "./session-registry.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { WandTaskAgent, WandTaskAgentEffort, WandTaskAgentProvider, WandTaskPriority, WandTaskStatus, WandTaskTitleSource } from "./task-types.js";
import { archiveBoardTask, syncUngroupedSessionsToBoard } from "./wand-task-sync.js";
import type { SessionProvider, SessionSnapshot, WandConfig } from "./types.js";

const STATUSES = new Set<WandTaskStatus>(["todo", "doing", "done"]);
const PRIORITIES = new Set<WandTaskPriority>(["none", "low", "medium", "high", "urgent"]);
const AGENT_PROVIDERS = new Set<WandTaskAgentProvider>(["claude", "codex", "opencode", "grok", "qoder", "pi"]);
const AGENT_EFFORTS = new Set<WandTaskAgentEffort>(["off", "standard", "deep", "max"]);
const TASK_BOARD_LAST_AGENT_KEY = "pref:taskBoardLastAgent";

function defaultTaskBoardAgent(): WandTaskAgent {
  return { provider: "claude", model: "default", thinkingEffort: "off" };
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
  });
}

export interface TaskRouteDependencies {
  storage: WandStorage;
  sessions?: SessionRegistry;
  structured?: StructuredSessionManager;
  config?: WandConfig;
  requireAdmin?: RequestHandler;
  /** 可注入的任务标题生成器；测试里换成同步桩，避免真的起 CLI。 */
  generateTitle?: typeof generateWandTaskTitle;
}

function dateValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new Error("截止日期必须使用 YYYY-MM-DD 格式。");
  }
  return value.trim();
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是对象。");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function labelsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

/** 任务派发配置：provider / model / thinkingEffort 三者必须同时给出且合法。 */
export function parseTaskAgent(value: unknown): WandTaskAgent | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent 配置必须是对象。");
  const body = value as Record<string, unknown>;
  const provider = text(body.provider) as WandTaskAgentProvider;
  if (!AGENT_PROVIDERS.has(provider)) throw new Error("请选择有效的 CLI 工具。");
  const model = text(body.model) || "default";
  if (model.length > 128) throw new Error("模型名称过长。");
  const thinkingEffort = (text(body.thinkingEffort) || "off") as WandTaskAgentEffort;
  if (!AGENT_EFFORTS.has(thinkingEffort)) throw new Error("思考深度无效。");
  return { provider, model, thinkingEffort };
}

interface TaskDtoDeps {
  storage: WandStorage;
  sessions?: SessionRegistry;
}

function taskDto({ storage, sessions }: TaskDtoDeps, task: ReturnType<WandStorage["getWandTask"]>) {
  if (!task) return null;
  const workspace = task.workspaceId ? storage.getWorkspace(task.workspaceId) : null;
  const sessionIds = storage.listWandTaskSessionIds(task.id);
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
  };
}

function sendTaskError(res: Response, error: unknown, fallback: string): void {
  res.status(400).json({ error: getErrorMessage(error, fallback) });
}

/**
 * 用户没写标题时，先用描述首行当占位标题，再由后台模型总结一个更好的。
 * 全程不阻塞创建请求：失败只是保留占位标题，不返回错误、也不覆盖用户后来改的标题。
 * 多次建任务会排队而不是丢弃，保证每张卡片最终都会拿到标题。
 */
let titleGenerationChain: Promise<void> = Promise.resolve();

function scheduleWandTaskTitleGeneration(
  storage: WandStorage,
  taskId: string,
  description: string,
  options: {
    cwd?: string;
    config?: WandConfig;
    generateTitle: typeof generateWandTaskTitle;
  },
): void {
  const cwd = options.cwd || options.config?.defaultCwd || process.cwd();
  const run = async (): Promise<void> => {
    try {
      const title = await options.generateTitle(description, cwd, options.config?.language ?? "", taskTitleAiOptions(options.config));
      const current = storage.getWandTask(taskId);
      // 用户已经自己写了标题（原生端 / 面板编辑）就不要覆盖。
      if (!current || current.titleSource !== "auto") return;
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

/** 自动生成标题没有会话上下文，按「默认 provider + 默认模型」解析，与提示词优化一致。 */
function taskTitleAiOptions(config?: WandConfig): QuickCommitAiOptions {
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
  // resolveSystemAiContext 会在直连 API 可用且已启用时优先走 API，否则回落到 CLI。
  return resolveSystemAiContext(defaultSession, config);
}

export function registerTaskRoutes(app: Express, deps: TaskRouteDependencies | WandStorage, sessionsLegacy?: SessionRegistry, requireAdminLegacy?: RequestHandler): void {
  // 兼容旧的 positional 调用；新代码统一用对象形式的依赖。
  const resolved: TaskRouteDependencies = deps && typeof deps === "object" && "storage" in deps
    ? deps as TaskRouteDependencies
    : { storage: deps as WandStorage, sessions: sessionsLegacy, requireAdmin: requireAdminLegacy };
  const { storage, sessions, structured, config } = resolved;
  const guard = resolved.requireAdmin ?? ((_req, _res, next) => next());
  const dto = (task: ReturnType<WandStorage["getWandTask"]>) => taskDto(resolved, task);

  app.get("/api/wand-tasks", guard, (req, res) => {
    try {
      syncUngroupedSessionsToBoard(storage);
    } catch (error) {
      console.error("[WandTask] Failed to sync ungrouped sessions onto the board:", getErrorMessage(error));
    }
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    res.json(storage.listWandTasks(workspaceId).map((task) => dto(task)));
  });
  app.get("/api/wand-task-agent-defaults", guard, (_req, res) => {
    res.json(readTaskBoardLastAgent(storage));
  });
  app.put("/api/wand-task-agent-defaults", guard, (req, res) => {
    try {
      const agent = parseTaskAgent(req.body);
      if (!agent) throw new Error("请选择有效的 CLI 工具。");
      writeTaskBoardLastAgent(storage, agent);
      res.json(agent);
    } catch (error) {
      sendTaskError(res, error, "无法保存 Agent 默认选项。");
    }
  });
  app.post("/api/wand-tasks", guard, (req, res) => {
    try {
      const body = bodyObject(req.body);
      const workspaceId = body.workspaceId === null ? null : text(body.workspaceId) || null;
      if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
      const description = text(body.description);
      // 标题是可选字段：用户不写就先用描述首行占位，再由模型在后台覆盖。
      const providedTitle = text(body.title);
      if (!providedTitle && !description) throw new Error("请填写任务标题或任务描述。");
      const titleSource: WandTaskTitleSource = providedTitle ? "user" : "auto";
      const title = providedTitle || provisionalTaskTitleFromDescription(description) || "新建任务";
      const status = STATUSES.has(body.status as WandTaskStatus) ? body.status as WandTaskStatus : "todo";
      const priority = PRIORITIES.has(body.priority as WandTaskPriority) ? body.priority as WandTaskPriority : "none";
      const agent = body.agent === undefined ? null : parseTaskAgent(body.agent);
      if (agent) writeTaskBoardLastAgent(storage, agent);
      const task = storage.createWandTask({
        workspaceId,
        title,
        titleSource,
        description,
        status,
        priority,
        labels: labelsFrom(body.labels),
        dueDate: dateValue(body.dueDate) ?? null,
        agent,
      });
      if (titleSource === "auto") {
        scheduleWandTaskTitleGeneration(storage, task.id, description, {
          cwd: workspaceId ? storage.getWorkspace(workspaceId)?.cwd : undefined,
          config,
          generateTitle: resolved.generateTitle ?? generateWandTaskTitle,
        });
      }
      res.status(201).json(dto(task));
    } catch (error) {
      sendTaskError(res, error, "无法创建任务。");
    }
  });
  app.patch("/api/wand-tasks/:id", guard, (req, res) => {
    try {
      const body = bodyObject(req.body);
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
      if (body.workspaceId !== undefined) {
        const workspaceId = body.workspaceId === null ? null : text(body.workspaceId);
        if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
        patch.workspaceId = workspaceId || null;
      }
      if (body.agent !== undefined) {
        patch.agent = parseTaskAgent(body.agent);
        if (patch.agent) writeTaskBoardLastAgent(storage, patch.agent);
      }
      if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
        patch.sortOrder = Math.floor(Number(body.sortOrder));
      }
      const task = storage.updateWandTask(req.params.id, patch);
      if (!task) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      if (task.status === "done") archiveBoardTask(storage, task.id);
      res.json(dto(storage.getWandTask(task.id) ?? task));
    } catch (error) {
      sendTaskError(res, error, "无法更新任务。");
    }
  });
  app.delete("/api/wand-tasks/:id", guard, (req, res) => {
    const archived = archiveBoardTask(storage, req.params.id);
    if (!archived) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    res.json({ ok: true, ...dto(archived) });
  });
  app.post("/api/wand-tasks/:id/sessions", guard, (req, res) => {
    try {
      const sessionId = text(bodyObject(req.body).sessionId);
      if (!sessionId) throw new Error("缺少 sessionId。");
      if (sessions && !sessions.get(sessionId)) throw new Error("未找到该会话。");
      storage.bindWandTaskSession(req.params.id, sessionId);
      res.status(201).json(dto(storage.getWandTask(req.params.id)));
    } catch (error) {
      sendTaskError(res, error, "无法绑定会话。");
    }
  });
  app.delete("/api/wand-tasks/:id/sessions/:sessionId", guard, (req, res) => {
    storage.unbindWandTaskSession(req.params.id, req.params.sessionId);
    res.json({ ok: true });
  });

  /**
   * 用选定的 CLI 工具开一个结构化会话，把这次派发的 prompt 作为首条消息，
   * 并把会话绑定回该任务。cwd 取任务所属项目目录；未指定项目时用全局默认目录。
   */
  app.post("/api/wand-tasks/:id/dispatch", guard, asyncRoute(async (req, res) => {
    try {
      let task = storage.getWandTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "未找到该任务。" });
        return;
      }
      if (!structured || !config) throw new Error("当前服务未启用结构化会话，无法派发 Agent。");
      const body = bodyObject(req.body);
      const agent = body.agent === undefined
        ? task.agent ?? parseWandTaskAgent(JSON.stringify(body))
        : parseTaskAgent(body.agent);
      if (!agent) throw new Error("请先为该任务选择 CLI 工具。");
      writeTaskBoardLastAgent(storage, agent);
      if (body.workspaceId !== undefined) {
        const workspaceId = body.workspaceId === null ? null : text(body.workspaceId) || null;
        if (workspaceId && !storage.getWorkspace(workspaceId)) throw new Error("项目不存在。");
        task = storage.updateWandTask(task.id, { workspaceId }) ?? task;
      }
      const workspace = task.workspaceId ? storage.getWorkspace(task.workspaceId) : null;
      if (task.workspaceId && !workspace) throw new Error("任务所属项目已被删除，请重新指定。");
      const cwd = workspace?.cwd || config.defaultCwd;
      const requestedPrompt = text(body.prompt);
      const existingSessions = storage.listWandTaskSessionIds(task.id).length;
      if (existingSessions > 0 && !requestedPrompt) throw new Error("请输入提示词。");
      const prompt = requestedPrompt || task.description.trim() || task.title || "执行此任务";
      const model = agent.model === "default" ? "" : agent.model;
      const session = structured.createSession({
        cwd,
        mode: "agent",
        provider: agent.provider as SessionProvider,
        model: model || getDefaultModelForProvider(config, agent.provider as SessionProvider) || undefined,
        thinkingEffort: agent.thinkingEffort,
        worktreeEnabled: false,
        sessionSource: "automation",
        automationId: `wand-task:${task.id}`,
        workspaceId: task.workspaceId ?? undefined,
        workspaceTaskId: task.workspaceTaskId ?? undefined,
      });
      storage.updateWandTask(task.id, { agent, status: task.status === "todo" ? "doing" : task.status });
      storage.bindWandTaskSession(task.id, session.id);
      const completion = structured.sendMessage(session.id, prompt);
      completion.catch((error) => console.error(`[WandTask] Agent dispatch failed for ${task.id}:`, error));
      res.status(202).json({
        ok: true,
        taskId: task.id,
        session: {
          id: session.id,
          provider: session.provider,
          model: session.selectedModel,
          thinkingEffort: session.thinkingEffort,
          cwd: session.cwd,
        },
      });
    } catch (error) {
      sendTaskError(res, error, "无法派发 Agent。");
    }
  }));

  app.get("/api/wand-tasks/:id", guard, asyncRoute(async (req, res) => {
    const task = dto(storage.getWandTask(req.params.id));
    if (!task) {
      res.status(404).json({ error: "未找到该任务。" });
      return;
    }
    res.json(task);
  }));
}
