import { isFixedAvatarEmployee } from "./fixed-employee-avatar.js";
import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";

import {
  AI_TEAM_MAX_CANDIDATES,
  SILICON_EMPLOYEE_AVATAR_MAX_CHARS,
  agentKey,
  isBuiltinSiliconEmployee,
  parseSiliconEmployeeTags,
  siliconEmployeeTags,
  type SiliconEmployee,
  type SiliconEmployeeDraft,
} from "./ai-team-types.js";
import type { OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";
import { parseTaskAgent } from "./server-task-routes.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { employeeCliAvailable } from "./silicon-employee-dispatch.js";
import {
  EMPLOYEE_CREATION_DEFAULTS_PREF,
  resolveSiliconEmployeeDefaults,
} from "./silicon-employee-defaults.js";
import {
  availableEmployeeProviders,
  generateSiliconEmployeeDraft,
  SiliconEmployeeDraftError,
  validateStructuredEmployeeDraft,
} from "./silicon-employee-draft.js";
import { SESSION_PROVIDERS } from "./session-provider.js";
import { parsePlushAvatar, parsePlushCatAvatar } from "./plush-avatar.js";
import { DEFAULT_WAND_TASK_AGENT_KIND } from "./task-types.js";
import type { QuickCommitAiOptions } from "./git-quick-commit.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES } from "./employee-knowledge-types.js";
import type { WandStorage } from "./storage.js";
import type { WandTaskAgent } from "./task-types.js";
import type { SessionProvider, WandConfig } from "./types.js";

/** 员工起草没有会话上下文，按「默认 provider」解析，与任务标题 / 提示词优化一致。 */
function employeeDraftAiOptions(storage: WandStorage, config?: WandConfig, free?: Pick<OpenRouterFreeModelsService, "resolveForCall">): QuickCommitAiOptions {
  if (!config) return {};
  const provider: SessionProvider = config.defaultProvider ?? "claude";
  return resolveSystemAiContext(
    {
      provider,
      structuredState: undefined,
      runner: undefined,
      command: provider === "qoder" ? "qodercli" : provider,
      selectedModel: null,
      thinkingEffort: config.defaultThinkingEffort,
    },
    config,
    storage.getSystemSiliconEmployee(),
    free,
  );
}

export interface EmployeeDraftRequest {
  expectation: string;
  existingNames: string[];
}

function sendEmployeeError(res: Response, error: unknown, context?: { expectation?: string }): void {
  const message = getErrorMessage(error, "硅基员工操作失败。");
  const status = /不存在/.test(message) ? 404 : 400;
  const code = error instanceof SiliconEmployeeDraftError ? error.code : undefined;
  const field = error instanceof SiliconEmployeeDraftError ? error.field : undefined;
  if (!code && !context?.expectation) {
    sendRouteError(res, error, "硅基员工操作失败。", status);
    return;
  }
  // 结构化可恢复错误：带 code/field，并回显原口语输入，客户端可继续编辑重试。
  res.status(status).json({
    error: message,
    ...(code ? { code } : {}),
    ...(field ? { field } : {}),
    ...(context?.expectation ? { expectation: context.expectation } : {}),
  });
}

/** 内置员工是 Wand 自己的执行者，不能被归档或删除。 */
function rejectSystemEmployeeMutation(existing: SiliconEmployee, action: string): void {
  if (!isBuiltinSiliconEmployee(existing)) return;
  throw new Error(`「${existing.name}」是 Wand 内置员工，不能${action}。`);
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  const result = text(value);
  if (result.length < min) throw new Error(`${label}不能为空。`);
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return result;
}

function parseAvatar(value: unknown, name: string): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`员工「${name}」的头像格式无效。`);
  }
  const avatar = text(value);
  if (!avatar || /^cat:\d{1,2}$/.test(avatar)) return avatar;
  if (parsePlushAvatar(avatar) || parsePlushCatAvatar(avatar)) return avatar;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
    throw new Error(`员工「${name}」的头像格式无效。`);
  }
  if (avatar.length > SILICON_EMPLOYEE_AVATAR_MAX_CHARS) {
    throw new Error(`员工「${name}」的头像太大。`);
  }
  return avatar;
}

/** Other built-ins keep profile locks; the two stable cat identities lock only avatar. */
const SYSTEM_EMPLOYEE_LOCKED_FIELDS: ReadonlyArray<{ key: "name" | "duty" | "prompt" | "avatar"; label: string }> = [
  { key: "name", label: "名字" },
  { key: "duty", label: "职责" },
  { key: "prompt", label: "角色设定" },
  { key: "avatar", label: "头像" },
];

/**
 * 其他内置员工只接受 agents；固定猫头员工另外接受资料的部分更新。
 * 锁定字段即使由旧客户端或直接 API 发来，也必须一致；不一致明确拒绝。
 */
export function parseSystemEmployeeAgents(value: unknown, existing: SiliconEmployee): WandTaskAgent[] {
  const body = bodyObject(value);
  for (const field of SYSTEM_EMPLOYEE_LOCKED_FIELDS.filter((field) => !isFixedAvatarEmployee(existing) || field.key === "avatar")) {
    const incoming = body[field.key];
    if (incoming === undefined || (incoming === null && !isFixedAvatarEmployee(existing))) continue;
    const current = existing[field.key];
    const isSame = typeof incoming === "string" && incoming === current;
    if (!isSame) {
      throw new Error(`该员工是内置的，${field.label}不可修改。`);
    }
  }

  if (body.tags !== undefined && JSON.stringify(body.tags) !== JSON.stringify(siliconEmployeeTags(existing))) {
    throw new Error("该员工是内置的，标签不可修改。");
  }
  if (isFixedAvatarEmployee(existing) && body.id !== undefined && body.id !== existing.id) throw new Error("该员工是内置的，身份不可修改。");
  if (body.systemKey !== undefined && body.systemKey !== existing.systemKey) {
    throw new Error("该员工是内置的，身份不可修改。");
  }

  return isFixedAvatarEmployee(existing) && body.agents === undefined ? existing.agents : parseEmployeeAgents(body.agents);
}

/** Partial edits preserve omitted fields and the raw saved prompt, not a generated read projection. */
export function parseFixedAvatarEmployeeInput(value: unknown, existing: SiliconEmployee, now: string): SiliconEmployee {
  const body = bodyObject(value);
  const agents = parseSystemEmployeeAgents(body, existing);
  const name = body.name === undefined ? existing.name : boundedText(body.name, "员工名字", 1, 40);
  const duty = body.duty === undefined ? existing.duty : text(body.duty);
  const prompt = body.prompt === undefined ? existing.prompt : text(body.prompt);
  if (duty.length > 2000) throw new Error("员工职责不能超过 2000 个字符。");
  if (prompt.length > 20_000) throw new Error("员工设定 Prompt 不能超过 20000 个字符。");
  return { ...existing, name, duty, prompt, agents, updatedAt: now };
}

/** One validation owner for every employee candidate list, including legacy single agents. */
function parseEmployeeAgents(value: unknown): WandTaskAgent[] {
  if (!Array.isArray(value)) throw new Error("请提供执行候选数组（CLI / SDK）。");
  if (value.length === 0) throw new Error("至少需要一个执行候选。");
  if (value.length > AI_TEAM_MAX_CANDIDATES) {
    throw new Error(`最多 ${AI_TEAM_MAX_CANDIDATES} 个执行候选。`);
  }
  const agents = value.map((rawAgent): WandTaskAgent => {
    const parsed = parseTaskAgent(rawAgent ?? {});
    if (!parsed) throw new Error("请选择有效的 CLI 工具或 Wand Agent。");
    if (parsed.kind !== "structured") throw new Error("硅基员工只支持结构化会话。");
    return parsed;
  });
  if (new Set(agents.map(agentKey)).size !== agents.length) {
    throw new Error("执行候选存在重复。");
  }
  return agents;
}

export function parseSiliconEmployeeInput(
  value: unknown,
  existing: SiliconEmployee | null,
  now: string,
): SiliconEmployee {
  const body = bodyObject(value);
  const name = boundedText(body.name, "员工名字", 1, 40);
  const duty = text(body.duty);
  if (duty.length > 2000) throw new Error("员工职责不能超过 2000 个字符。");
  const prompt = text(body.prompt);
  if (prompt.length > 20_000) throw new Error("员工设定 Prompt 不能超过 20000 个字符。");

  let candidates: unknown;
  if (Array.isArray(body.agents)) candidates = body.agents;
  else if (body.agents !== undefined && body.agents !== null) throw new Error("候选执行配置必须是数组。");
  else if (body.agent !== undefined && body.agent !== null) candidates = [body.agent];
  else throw new Error("至少需要一个执行候选。");
  const agents = parseEmployeeAgents(candidates);

  const avatar = parseAvatar(body.avatar, name);
  const tags = parseSiliconEmployeeTags(body.tags === undefined ? existing?.tags ?? [] : body.tags);

  const id = existing?.id ?? `e_${randomUUID().replace(/-/g, "")}`;

  return {
    id,
    name,
    duty,
    prompt,
    avatar,
    agents,
    tags,
    archivedAt: existing?.archivedAt,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
}

export function registerSiliconEmployeeRoutes(
  app: Express,
  deps: {
    storage: WandStorage;
    notifyEmployeeChanged?: (employeeId: string) => void;
    config?: WandConfig;
    free?: Pick<OpenRouterFreeModelsService, "resolveForCall">;
    /** 测试注入点：默认按系统 AI 配置真实调用模型。 */
    generateDraft?: (request: EmployeeDraftRequest) => Promise<SiliconEmployeeDraft>;
    /** 测试注入点：CLI 可用性探测。 */
    isProviderAvailable?: (agent: WandTaskAgent) => boolean;
  },
): void {
  const { storage, notifyEmployeeChanged, config } = deps;
  const isProviderAvailable = deps.isProviderAvailable ?? employeeCliAvailable;
  /** 已保存的员工创建配置优先；没有就用服务端 defaultProvider；再没有就要求用户选择。 */
  const savedEmployeeAgent = (): WandTaskAgent | null => {
    const raw = storage.getPreference<unknown>(EMPLOYEE_CREATION_DEFAULTS_PREF, null);
    if (!raw) return null;
    try {
      const agent = parseTaskAgent(raw, undefined, DEFAULT_WAND_TASK_AGENT_KIND);
      return agent?.kind === "structured" ? agent : null;
    } catch {
      return null;
    }
  };
  const resolveDefaults = () =>
    resolveSiliconEmployeeDefaults({ savedAgent: savedEmployeeAgent(), config });
  const allowedProviders = (): SessionProvider[] => {
    const available = availableEmployeeProviders(resolveDefaults().provider, isProviderAvailable);
    return available.length ? available : [...SESSION_PROVIDERS];
  };
  const generateDraft = deps.generateDraft ?? ((request: EmployeeDraftRequest) =>
    generateSiliconEmployeeDraft(request.expectation, employeeDraftAiOptions(storage, config, deps.free), {
      cwd: config?.defaultCwd || process.cwd(),
      language: config?.language ?? "",
      existingNames: request.existingNames,
      preferredProvider: resolveDefaults().provider,
      isProviderAvailable,
    }));
  const notifyEmployee = (employeeId: string): void => {
    try {
      notifyEmployeeChanged?.(employeeId);
    } catch (error) {
      console.error("[SiliconEmployee] definition notification failed:", getErrorMessage(error));
    }
  };

  app.get("/api/silicon-employees", (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
      const employees = storage.listSiliconEmployees({ includeArchived });
      res.json({ employees });
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  /** 两端唯一的默认执行配置读取点；未配置时如实返回需要用户选择。 */
  app.get("/api/silicon-employees/draft/defaults", (_req, res) => {
    res.json(resolveDefaults());
  });

  /** 显式保存员工创建默认配置（只落偏好，不创建员工实体）。 */
  app.put("/api/silicon-employees/draft/defaults", (req, res) => {
    try {
      const agent = parseTaskAgent(req.body ?? {}, undefined, DEFAULT_WAND_TASK_AGENT_KIND);
      if (!agent) throw new Error("请选择有效的执行候选。");
      if (agent.kind !== "structured") throw new Error("硅基员工只支持结构化会话。");
      storage.setPreference(EMPLOYEE_CREATION_DEFAULTS_PREF, {
        provider: agent.provider,
        model: agent.model,
        thinkingEffort: agent.thinkingEffort,
        mode: agent.mode,
        kind: agent.kind,
        ...(agent.engine ? { engine: agent.engine } : {}),
      });
      res.json(resolveDefaults());
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.post("/api/silicon-employees/draft", asyncRoute(async (req, res) => {
    let expectation = "";
    try {
      const body = bodyObject(req.body);
      expectation = text(body.expectation);
      const existingNames = storage.listSiliconEmployees({ includeArchived: true })
        .map((employee) => employee.name);
      // HR 已给完整结构化草稿：走同一校验，不再调用模型。
      if (body.draft !== undefined && body.draft !== null) {
        const draft = validateStructuredEmployeeDraft(body.draft, {
          allowedProviders: allowedProviders(), existingNames,
        });
        res.json({ draft, usage: { generateCalls: 0, path: "validated" as const } });
        return;
      }
      if (!expectation) {
        throw new SiliconEmployeeDraftError("先说说你对这位员工的期望吧。", "EMPTY_EXPECTATION", "expectation");
      }
      const draft = await generateDraft({ expectation, existingNames });
      res.json({ draft, usage: { generateCalls: 1, path: "generated" as const } });
    } catch (error) {
      sendEmployeeError(res, error, { expectation });
    }
  }));

  app.post("/api/silicon-employees", (req, res) => {
    try {
      const now = new Date().toISOString();
      const employee = parseSiliconEmployeeInput(req.body, null, now);
      storage.saveSiliconEmployee(employee);
      notifyEmployee(employee.id);
      res.status(201).json(employee);
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.get("/api/silicon-employees/:id", (req, res) => {
    try {
      const employee = storage.getSiliconEmployee(req.params.id);
      if (!employee) throw new Error(`硅基员工「${req.params.id}」不存在。`);
      res.json(employee);
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.get("/api/silicon-employees/:id/knowledge", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const employeeId = req.params.id;
      const query = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ employeeId, entries: storage.listEmployeeKnowledge(employeeId, query),
        total: storage.countEmployeeKnowledge(employeeId), maxEntries: EMPLOYEE_KNOWLEDGE_MAX_ENTRIES });
    } catch (error) { sendEmployeeError(res, error); }
  });

  app.post("/api/silicon-employees/:id/knowledge", (req, res) => {
    try {
      const body = bodyObject(req.body);
      if (typeof body.content !== "string") throw new Error("content 必须是知识文字。");
      const entry = storage.rememberEmployeeKnowledge(req.params.id, body.content);
      res.status(201).json(entry);
    } catch (error) { sendEmployeeError(res, error); }
  });

  app.delete("/api/silicon-employees/:id/knowledge/:entryId", (req, res) => {
    try {
      const deleted = storage.forgetEmployeeKnowledge(req.params.id, req.params.entryId);
      if (!deleted) { res.status(404).json({ error: "该知识不属于当前员工或已删除。" }); return; }
      res.json({ deleted: true });
    } catch (error) { sendEmployeeError(res, error); }
  });

  app.delete("/api/silicon-employees/:id/knowledge", (req, res) => {
    try {
      storage.clearEmployeeKnowledge(req.params.id);
      res.json({ employeeId: req.params.id, entries: [], total: 0, maxEntries: EMPLOYEE_KNOWLEDGE_MAX_ENTRIES });
    } catch (error) { sendEmployeeError(res, error); }
  });

  app.put("/api/silicon-employees/:id", (req, res) => {
    try {
      const existing = storage.getSiliconEmployee(req.params.id);
      if (!existing) throw new Error(`硅基员工「${req.params.id}」不存在。`);
      const now = new Date().toISOString();
      const definition = storage.getSiliconEmployeeDefinition(existing.id)!;
      const body = bodyObject(req.body);
      // An unchanged projected prompt is an echo, not a request to persist generated preferences.
      const input = body.prompt === existing.prompt ? { ...body, prompt: definition.prompt } : body;
      const employee = isFixedAvatarEmployee(definition)
        ? parseFixedAvatarEmployeeInput(input, definition, now)
        : isBuiltinSiliconEmployee(existing)
          ? { ...existing, agents: parseSystemEmployeeAgents(input, existing), updatedAt: now }
          : parseSiliconEmployeeInput(input, existing, now);
      storage.saveSiliconEmployee(employee);
      notifyEmployee(employee.id);
      res.json(employee);
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.post("/api/silicon-employees/:id/archive", (req, res) => {
    try {
      const existing = storage.getSiliconEmployee(req.params.id);
      if (!existing) throw new Error(`硅基员工「${req.params.id}」不存在。`);
      rejectSystemEmployeeMutation(existing, "归档");
      const now = new Date().toISOString();
      storage.archiveSiliconEmployee(req.params.id, now);
      notifyEmployee(req.params.id);
      res.json({ ok: true, archivedAt: now });
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.post("/api/silicon-employees/:id/unarchive", (req, res) => {
    try {
      const existing = storage.getSiliconEmployee(req.params.id);
      if (!existing) throw new Error(`硅基员工「${req.params.id}」不存在。`);
      rejectSystemEmployeeMutation(existing, "恢复");
      storage.unarchiveSiliconEmployee(req.params.id);
      notifyEmployee(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });

  app.delete("/api/silicon-employees/:id", (req, res) => {
    try {
      const existing = storage.getSiliconEmployee(req.params.id);
      if (!existing) throw new Error(`硅基员工「${req.params.id}」不存在。`);
      rejectSystemEmployeeMutation(existing, "删除");
      storage.deleteSiliconEmployee(req.params.id);
      notifyEmployee(req.params.id);
      res.status(204).end();
    } catch (error) {
      sendEmployeeError(res, error);
    }
  });
}
