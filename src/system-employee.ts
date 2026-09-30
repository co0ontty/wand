import {
  SYSTEM_EMPLOYEE_ID,
  SYSTEM_EMPLOYEE_KEY,
  SYSTEM_EMPLOYEE_NAME,
  SYSTEM_EMPLOYEE_TAG,
  isSystemSiliconEmployee,
  type SiliconEmployee,
} from "./ai-team-types.js";
import { isSessionProvider } from "./session-provider.js";
import { DEFAULT_WAND_TASK_AGENT_KIND, DEFAULT_WAND_TASK_AGENT_MODE, normalizeWandTaskAgentMode, type WandTaskAgent } from "./task-types.js";
import type { AiCliCandidate, SessionProvider } from "./types.js";

// 常量与判定定义在 ai-team-types（浏览器也要用），这里再导出一次，服务端只从一个地方引用。
export {
  SYSTEM_EMPLOYEE_ID,
  SYSTEM_EMPLOYEE_KEY,
  SYSTEM_EMPLOYEE_NAME,
  SYSTEM_EMPLOYEE_TAG,
  isSystemSiliconEmployee,
};

/**
 * 内置的「系统运维」员工。
 *
 * Wand 自己的 AI 调用（commit message / tag、提示词优化、会话与任务标题、
 * 员工起草）都由这位员工执行：名字、职责与人设写死在代码里，不可编辑、不可归档、
 * 不可删除；只有执行候选（CLI 工具 + 模型 + 思考深度，按顺序降级）由用户维护。
 */
export const SYSTEM_EMPLOYEE_DUTY = "Wand 系统运维：服务与 CLI 线路、更新分发、仓库与会话操作，Wand 自有 AI 任务的执行者。";

/**
 * 同时承担两个角色，所以规则写在一起：
 *   - 作为会话系统提示：用户直接找它做运维/功能实现；
 *   - 作为内部 AI 调用的系统提示：任务通常带严格输出格式。
 */
export const SYSTEM_EMPLOYEE_PROMPT = [
  `你是 Wand 的系统运维「${SYSTEM_EMPLOYEE_NAME}」。你常驻在这台机器上，负责 Wand 自身的运转：服务与守护进程、CLI 与模型线路、更新与分发、会话与终端、SQLite 配置、以及仓库与提交操作。`,
  "",
  "工作方式：",
  "- 先看真实状态再动手：读日志、跑命令、看 diff，不靠猜测下结论，也不编造没有执行过的结果。",
  "- 改动小而准：只解决当下这件事，不顺手重构；发现同类问题就一并修掉并说明。",
  "- 危险操作（删除数据、强推、改权限、停服）先说清后果再执行；无法确认时停下来问，不要赌。",
  "- 用中文汇报，先说结论再说证据；引用命令与文件路径，不贴无用日志。",
  "",
  "格式纪律：当任务给出了明确的输出格式、字段或字数限制（例如一行 commit message、只输出一个 JSON 对象、只输出标题），一律严格照做——",
  "不寒暄、不解释、不加「优化后：」这类前后缀、不包代码块、不输出思考过程；绝不复述任务里没有的信息。",
].join("\n");

export interface SystemEmployeeSeed {
  /** 老配置里的「系统 AI 专用工具」；没有时跟随默认 provider。 */
  cli?: SessionProvider | null;
  /** 该工具下的模型；空 / "default" 表示跟随 provider 默认模型。 */
  model?: string | null;
  /** 没有专用工具时的默认 provider。 */
  provider?: SessionProvider | null;
}

/** 首次创建内置员工时使用的候选：优先沿用用户已有的系统 AI 工具与模型。 */
export function systemEmployeeSeedAgents(seed: SystemEmployeeSeed = {}): WandTaskAgent[] {
  const cli = isSessionProvider(seed.cli) ? seed.cli : null;
  const provider: SessionProvider = cli
    ?? (isSessionProvider(seed.provider) ? seed.provider : "claude");
  const model = cli ? (seed.model ?? "").trim() || "default" : "default";
  return [{
    provider,
    model,
    thinkingEffort: "off",
    mode: normalizeWandTaskAgentMode(provider, DEFAULT_WAND_TASK_AGENT_MODE),
    kind: DEFAULT_WAND_TASK_AGENT_KIND,
  }];
}

export function systemEmployeeDefinition(agents: WandTaskAgent[], now: string, existing?: SiliconEmployee | null): SiliconEmployee {
  return {
    id: existing?.id ?? SYSTEM_EMPLOYEE_ID,
    name: SYSTEM_EMPLOYEE_NAME,
    duty: SYSTEM_EMPLOYEE_DUTY,
    prompt: SYSTEM_EMPLOYEE_PROMPT,
    // 空头像 = 按 id/name 稳定派生一只像素猫，与用户员工同一套。
    avatar: "",
    agents: agents.length ? agents : systemEmployeeSeedAgents(),
    systemKey: SYSTEM_EMPLOYEE_KEY,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** 内置员工只保留结构化候选（会话与内部 AI 调用都要求结构化执行）。 */
export function systemEmployeeAgentsOrNull(value: unknown): WandTaskAgent[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value as WandTaskAgent[];
}

/**
 * 内部 AI 调用的 CLI 降级链：按用户设置的顺序，模型为空 / "default" 时跟随 provider 默认值。
 */
export function systemEmployeeCliCandidates(employee: Pick<SiliconEmployee, "agents"> | null | undefined): AiCliCandidate[] {
  if (!employee) return [];
  return employee.agents
    .filter((agent) => agent.kind === "structured")
    .map((agent) => {
      const model = (agent.model ?? "").trim();
      return {
        provider: agent.provider,
        model: !model || model === "default" ? undefined : model,
        thinkingEffort: agent.thinkingEffort,
      };
    });
}
