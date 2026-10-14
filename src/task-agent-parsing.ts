import { text } from "./server-request.js";
import { isSessionProvider } from "./session-provider.js";
import { type WandStorage } from "./storage.js";
import { isThinkingEffort } from "./structured-provider-common.js";
import type { WandTaskAgent, WandTaskAgentEngine, WandTaskAgentKind, WandTaskAgentMode } from "./task-types.js";
import { DEFAULT_WAND_TASK_AGENT_KIND, DEFAULT_WAND_TASK_AGENT_MODE, isWandTaskAgentEngine, isWandTaskAgentKind, isWandTaskAgentMode, normalizeWandTaskAgentMode } from "./task-types.js";
import { badRequest } from "./http-error.js";
import { AI_TEAM_MAX_CANDIDATES, agentKey } from "./ai-team-types.js";

/** Request parsing for task agents and parent-task links, shared by task, team and employee routes. */
/** 新认领只能挂到同项目且正在处理的任务；历史归属在父任务完成后仍保留。 */
export function parentTaskIdFrom(
  storage: WandStorage,
  value: unknown,
  workspaceId: string | null,
  childId: string | null = null,
  existingParentId: string | null = null,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw badRequest("父任务无效。");
  const parentId = value.trim();
  const parent = storage.getWandTask(parentId);
  if (!parent) throw badRequest("父任务不存在。");
  if (parent.workspaceId !== workspaceId) throw badRequest("父任务必须与子任务属于同一项目目录。");
  if (parent.status !== "doing" && parentId !== existingParentId) {
    throw badRequest("只能认领到正在处理的父任务。");
  }
  // 不允许自己做父任务，也不允许把祖先接到后代下。
  const visited = new Set<string>();
  let ancestorId: string | null = parentId;
  while (ancestorId) {
    if (ancestorId === childId || visited.has(ancestorId)) throw badRequest("父任务不能形成循环。");
    visited.add(ancestorId);
    ancestorId = storage.getWandTask(ancestorId)?.parentTaskId ?? null;
  }
  return parentId;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("Agent 配置必须是对象。");
  const body = value as Record<string, unknown>;
  const provider = text(body.provider);
  if (!isSessionProvider(provider)) throw badRequest("请选择有效的 CLI 工具。");
  const model = text(body.model) || "default";
  if (model.length > 128) throw badRequest("模型名称过长。");
  const thinkingEffort = text(body.thinkingEffort) || "off";
  if (!isThinkingEffort(thinkingEffort)) throw badRequest("思考深度无效。");
  const rawMode = body.mode === undefined || body.mode === null || body.mode === "" ? fallbackMode : body.mode;
  if (!isWandTaskAgentMode(rawMode)) throw badRequest("工作模式无效。");
  // Codex 之类只认一种模式的 provider 在这里夹到有效值，落库值与实际执行保持一致。
  const mode = normalizeWandTaskAgentMode(provider, rawMode);
  // kind 与 mode 同样兼容老客户端：不传就沿用任务当前值，避免把 PTY 悄悄复位成结构化。
  const rawKind = body.kind === undefined || body.kind === null || body.kind === "" ? fallbackKind : body.kind;
  if (!isWandTaskAgentKind(rawKind)) throw badRequest("会话形态无效。");
  const rawEngine = body.engine === undefined || body.engine === null || body.engine === "" ? "cli" : body.engine;
  if (!isWandTaskAgentEngine(rawEngine)) throw badRequest("执行引擎无效。");
  if (rawEngine === "sdk" && (provider !== "pi" || rawKind !== "structured")) {
    throw badRequest("Wand Agent 仅支持结构化会话。");
  }
  const engine: WandTaskAgentEngine | undefined = rawEngine === "sdk" ? rawEngine : undefined;
  return { provider, model, thinkingEffort, mode, kind: rawKind, ...(engine ? { engine } : {}) };
}

/** Callers retain their array/legacy-input errors and per-candidate policy order. */
export function parseTaskAgentCandidates(
  values: readonly unknown[],
  validateCandidate?: (candidate: WandTaskAgent) => void,
): WandTaskAgent[] {
  if (values.length === 0) throw badRequest("至少需要一个执行候选。");
  if (values.length > AI_TEAM_MAX_CANDIDATES) {
    throw badRequest(`最多 ${AI_TEAM_MAX_CANDIDATES} 个执行候选。`);
  }
  return values.map((raw): WandTaskAgent => {
    const candidate = parseTaskAgent(raw ?? {});
    if (!candidate) throw badRequest("请选择有效的 CLI 工具。");
    validateCandidate?.(candidate);
    return candidate;
  });
}

/** Preserve literal model/default and CLI/SDK identity; callers own duplicate errors. */
export function hasDuplicateTaskAgentCandidates(agents: readonly WandTaskAgent[]): boolean {
  return new Set(agents.map(agentKey)).size !== agents.length;
}
