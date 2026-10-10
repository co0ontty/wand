import type { SiliconEmployee } from "./ai-team-types.js";
import { SYSTEM_EMPLOYEE_TAG } from "./ai-team-types.js";
import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY, DECISION_EXPERT_NAME, WAND_LOCAL_DECISION_MODEL } from "./decision-expert-identity.js";
import { OPENROUTER_FREE_SELECTOR } from "./openrouter-free-selection.js";
import type { WandTaskAgent } from "./task-types.js";

export const DECISION_EXPERT_DUTY = "Wand 决策专家：根据最少必要证据做有界选择、评分与是非判断；按已配置工具与模型顺序调用；本地决策先核对本机能力。";
export const DECISION_EXPERT_PROMPT = [
  "你是 Wand 内置系统员工「决策专家」。你的职责是基于用户提供的证据，做有界候选选择、评分与是非判断。",
  "按员工调用链的配置顺序调用工具与模型；初始候选为 LAYA 和 Wand 免费分组。LAYA 不生成开放式文本，不伪装成聊天模型。",
  "先核对机器的 CPU、内存、Apple Silicon / Metal 和运行时健康。性能/平台不足时明确说明原因，建议配置你的调用链，不能捏造可以运行。",
  "只使用输入中已授权的最少证据，不读取别人的知识/私聊。概率不是正确性保证，更不是权限、删除、发布或付款批准。",
  "严格输出任务要求的格式；不编造选项、解释、执行结果或事实。失败有明确原因，不盲目重复已执行/未知送达的工作。",
  "免费分组在每次请求前重新核对价格；免费候选不可用时依调用链处理，不把免费选择器替换成付费模型。",
].join("\n");
export function decisionExpertSeedAgents(): WandTaskAgent[] {
  return [WAND_LOCAL_DECISION_MODEL, OPENROUTER_FREE_SELECTOR].map(model => ({ provider: "pi", engine: "sdk", model,
    thinkingEffort: "off", mode: "default", kind: "structured" }));
}
export function decisionExpertDefinition(now: string, existing?: SiliconEmployee | null): SiliconEmployee {
  return { id: existing?.id ?? DECISION_EXPERT_ID, systemKey: DECISION_EXPERT_KEY, name: DECISION_EXPERT_NAME,
    duty: DECISION_EXPERT_DUTY, prompt: DECISION_EXPERT_PROMPT, avatar: "", tags: [SYSTEM_EMPLOYEE_TAG],
    agents: existing?.agents.length ? existing.agents : decisionExpertSeedAgents(),
    createdAt: existing?.createdAt ?? now, updatedAt: now };
}
