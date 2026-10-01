import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";

import {
  AI_TEAM_MAX_CANDIDATES,
  SILICON_EMPLOYEE_AVATAR_MAX_CHARS,
  agentKey,
  isBuiltinSiliconEmployee,
  type SiliconEmployee,
  type SiliconEmployeeDraft,
} from "./ai-team-types.js";
import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";
import { parseTaskAgent } from "./server-task-routes.js";
import { resolveSystemAiContext } from "./session-ai-context.js";
import { generateSiliconEmployeeDraft } from "./silicon-employee-draft.js";
import type { QuickCommitAiOptions } from "./git-quick-commit.js";
import { EMPLOYEE_KNOWLEDGE_MAX_ENTRIES } from "./employee-knowledge-types.js";
import type { WandStorage } from "./storage.js";
import type { WandTaskAgent } from "./task-types.js";
import type { SessionProvider, WandConfig } from "./types.js";

/** 员工起草没有会话上下文，按「默认 provider」解析，与任务标题 / 提示词优化一致。 */
function employeeDraftAiOptions(storage: WandStorage, config?: WandConfig): QuickCommitAiOptions {
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
  );
}

export interface EmployeeDraftRequest {
  expectation: string;
  existingNames: string[];
}

function sendEmployeeError(res: Response, error: unknown): void {
  const message = getErrorMessage(error, "硅基员工操作失败。");
  const status = /不存在/.test(message) ? 404 : 400;
  sendRouteError(res, error, "硅基员工操作失败。", status);
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
  const avatar = text(value);
  if (!avatar || /^cat:\d{1,2}$/.test(avatar)) return avatar;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
    throw new Error(`员工「${name}」的头像格式无效。`);
  }
  if (avatar.length > SILICON_EMPLOYEE_AVATAR_MAX_CHARS) {
    throw new Error(`员工「${name}」的头像太大。`);
  }
  return avatar;
}

/** 内置员工的锁定字段：名字 / 职责 / 人设 / 头像写死在服务端，只有候选可改。 */
const SYSTEM_EMPLOYEE_LOCKED_FIELDS: ReadonlyArray<{ key: "name" | "duty" | "prompt" | "avatar"; label: string }> = [
  { key: "name", label: "名字" },
  { key: "duty", label: "职责" },
  { key: "prompt", label: "角色设定" },
  { key: "avatar", label: "头像" },
];

/**
 * 内置员工只接受 agents；其余字段即使前端遗漏地发上来也必须与服务端一致，
 * 不一致直接拒绝（静默忽略会让客户端以为改成功了）。
 */
export function parseSystemEmployeeAgents(value: unknown, existing: SiliconEmployee): WandTaskAgent[] {
  const body = bodyObject(value);
  for (const field of SYSTEM_EMPLOYEE_LOCKED_FIELDS) {
    const incoming = body[field.key];
    if (incoming === undefined || incoming === null) continue;
    const current = existing[field.key];
    const isSame = typeof incoming === "string" && incoming === current;
    if (!isSame) {
      throw new Error(`该员工是内置的，${field.label}不可修改。`);
    }
  }

  if (!Array.isArray(body.agents)) throw new Error("请提供执行候选数组。");
  if (body.agents.length === 0) throw new Error("至少需要一个执行候选。");
  if (body.agents.length > AI_TEAM_MAX_CANDIDATES) {
    throw new Error(`最多 ${AI_TEAM_MAX_CANDIDATES} 个执行候选。`);
  }
  const agents = body.agents.map((rawAgent): WandTaskAgent => {
    const parsed = parseTaskAgent(rawAgent ?? {});
    if (!parsed) throw new Error("请选择有效的 CLI 工具。");
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

  let agents: WandTaskAgent[];
  if (Array.isArray(body.agents)) {
    if (body.agents.length === 0) throw new Error("至少需要一个执行候选。");
    if (body.agents.length > AI_TEAM_MAX_CANDIDATES) {
      throw new Error(`最多 ${AI_TEAM_MAX_CANDIDATES} 个执行候选。`);
    }
    agents = body.agents.map((rawAgent): WandTaskAgent => {
      const parsed = parseTaskAgent(rawAgent ?? {});
      if (!parsed) throw new Error("请选择有效的 CLI 工具。");
      if (parsed.kind !== "structured") throw new Error("硅基员工只支持结构化会话。");
      return parsed;
    });
  } else if (body.agents !== undefined && body.agents !== null) {
    throw new Error("候选执行配置必须是数组。");
  } else if (body.agent !== undefined && body.agent !== null) {
    const singleAgent = parseTaskAgent(body.agent);
    if (!singleAgent) throw new Error("请选择有效的 CLI 工具。");
    if (singleAgent.kind !== "structured") throw new Error("硅基员工只支持结构化会话。");
    agents = [singleAgent];
  } else {
    throw new Error("至少需要一个执行候选。");
  }

  const seenKeys = new Set(agents.map(agentKey));
  if (seenKeys.size !== agents.length) {
    throw new Error("执行候选存在重复。");
  }

  const avatar = parseAvatar(body.avatar, name);

  const id = existing?.id ?? `e_${randomUUID().replace(/-/g, "")}`;

  return {
    id,
    name,
    duty,
    prompt,
    avatar,
    agents,
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
    /** 测试注入点：默认按系统 AI 配置真实调用模型。 */
    generateDraft?: (request: EmployeeDraftRequest) => Promise<SiliconEmployeeDraft>;
  },
): void {
  const { storage, notifyEmployeeChanged, config } = deps;
  const generateDraft = deps.generateDraft ?? ((request: EmployeeDraftRequest) =>
    generateSiliconEmployeeDraft(request.expectation, employeeDraftAiOptions(storage, config), {
      cwd: config?.defaultCwd || process.cwd(),
      language: config?.language ?? "",
      existingNames: request.existingNames,
      preferredProvider: config?.defaultProvider ?? "claude",
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

  app.post("/api/silicon-employees/draft", asyncRoute(async (req, res) => {
    try {
      const body = bodyObject(req.body);
      const expectation = text(body.expectation);
      const existingNames = storage.listSiliconEmployees({ includeArchived: true })
        .map((employee) => employee.name);
      const draft = await generateDraft({ expectation, existingNames });
      res.json({ draft });
    } catch (error) {
      sendEmployeeError(res, error);
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
      const employee = isBuiltinSiliconEmployee(existing)
        ? { ...existing, agents: parseSystemEmployeeAgents(req.body, existing), updatedAt: now }
        : parseSiliconEmployeeInput(req.body, existing, now);
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
