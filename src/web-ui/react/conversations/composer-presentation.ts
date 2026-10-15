import type { ConversationDetail } from "../../../conversation-types.js";
import { normalizeWandTaskAgentMode, type WandTaskAgent } from "../../../task-types.js";
import { agentToolDisplayName } from "../../provider-identity.js";
import { compactThinkingLabel, dynamicThinkingChoices } from "../../thinking-efforts.js";
import { catalogThinkingEfforts, wandModelDisplayName, type WandModelCatalog } from "../model-catalog.js";

/** Each DM message owns its execution; the legacy communication channel is never a continuation target. */
export function latestDirectWork(detail: ConversationDetail | null): { sessionId: string; title: string } | null {
  if (detail?.kind !== "dm") return null;
  for (let index = detail.messages.length - 1; index >= 0; index--) {
    const message = detail.messages[index]!;
    if (message.sessionLink?.sessionId && message.sessionPreview?.status !== "unavailable") {
      return { sessionId: message.sessionLink.sessionId, title: message.sessionLink.title || "上一项工作" };
    }
  }
  return null;
}

/** A preference summary, not a claim about an already running or fallback execution. */
export function directWorkPreference(agent: WandTaskAgent | undefined): string {
  if (!agent) return "执行配置未就绪";
  const tool = agentToolDisplayName(agent.provider, agent.engine);
  const mode = normalizeWandTaskAgentMode(agent.provider, agent.mode);
  const permission = { "full-access": "完全访问", default: "标准权限", "auto-edit": "自动编辑", native: "工具原生权限", managed: "Wand 托管权限" }[mode];
  const { model: modelLabel, thinking } = composerRuntimePreference(agent);
  return `首选 ${tool} · ${permission} · ${modelLabel} · 思考：${thinking}`;
}

/** Configured preference only; defaults and fallback results are not invented. */
export function composerRuntimePreference(agent: WandTaskAgent | undefined, catalog: WandModelCatalog | null = null): { model: string; thinking: string } {
  if (!agent) return { model: "配置未就绪", thinking: "未取得" };
  const model = agent.model?.trim();
  const modelLabel = wandModelDisplayName(catalog, agent.provider, model) || "工具默认模型（待解析）";
  const effort = agent.thinkingEffort || "off";
  const legacyLabels: Record<string, string> = { off: "自动（模型默认）", standard: "标准", deep: "深入", max: "最大" };
  const source = catalogThinkingEfforts(catalog, agent.provider, modelLabel);
  const native = dynamicThinkingChoices(agent.provider, source.efforts, source.defaultEffort)?.find(choice => choice.id === effort)?.label;
  const thinking = (native ? compactThinkingLabel(native) : undefined) ?? legacyLabels[effort]
    ?? compactThinkingLabel(effort.includes(":") ? effort.slice(effort.indexOf(":") + 1) : effort);
  return { model: modelLabel, thinking };
}
