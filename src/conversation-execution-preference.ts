import type { SiliconEmployee } from "./ai-team-types.js";
import { isSessionProvider } from "./provider-catalog.js";
import { isThinkingEffort } from "./structured-provider-common.js";
import { normalizeWandTaskAgentMode, type WandTaskAgent } from "./task-types.js";

/** Request-local only: never saved to the employee or used to mutate an existing run. */
export type ConversationExecutionPreference = Pick<WandTaskAgent, "provider" | "engine" | "model" | "thinkingEffort">;

export function parseConversationExecutionPreference(value: unknown): ConversationExecutionPreference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("临时执行配置无效。");
  const body = value as Record<string, unknown>;
  if (!isSessionProvider(body.provider) || (body.engine !== undefined && body.engine !== "cli" && body.engine !== "sdk")
    || (body.engine === "sdk" && body.provider !== "pi")) throw new Error("临时执行工具无效。");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 128) throw new Error("临时模型无效。");
  if (!isThinkingEffort(body.thinkingEffort)
    || (body.thinkingEffort.includes(":") && !body.thinkingEffort.startsWith(`${body.provider}:`))) throw new Error("临时思考深度无效。");
  return { provider: body.provider, engine: body.engine as "cli" | "sdk" | undefined,
    model: body.model.trim(), thinkingEffort: body.thinkingEffort };
}

/** Manual selection is a single explicit candidate, not an implicit paid/fallback chain. */
export function withConversationExecutionPreference(employee: SiliconEmployee, preference: ConversationExecutionPreference): SiliconEmployee {
  const base = employee.agents.find(agent => agent.provider === preference.provider && (agent.engine ?? "cli") === (preference.engine ?? "cli"));
  return { ...employee, agents: [{ ...preference, kind: "structured",
    mode: normalizeWandTaskAgentMode(preference.provider, base?.mode) }] };
}
