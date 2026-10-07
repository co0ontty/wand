import { getDefaultModelForProvider, type ProviderModelField } from "./config.js";
import { employeeAgentFor } from "./silicon-employee-draft.js";
import { isSessionProvider } from "./session-provider.js";
import type { WandTaskAgent } from "./task-types.js";
import type { SessionProvider, WandConfig } from "./types.js";

/**
 * 员工创建默认执行配置（用户显式保存的那份）。与看板的
 * `pref:taskBoardLastAgent` 分开：任务默认跟随最近派发，员工默认只跟用户确认过的创建配置。
 */
export const EMPLOYEE_CREATION_DEFAULTS_PREF = "pref:employeeCreationAgent";

export type EmployeeDefaultsConfig = Pick<WandConfig, "defaultProvider" | ProviderModelField>;

export interface SiliconEmployeeDefaults {
  configured: boolean;
  /** false 时唯一合法动作是让用户自己选；服务端不替任何端硬编码默认。 */
  requiresUserChoice: boolean;
  source?: "saved" | "server";
  provider?: SessionProvider;
  /** 新员工将使用的执行候选；与「生成草稿用的系统 AI 模型」是两条独立链路。 */
  agent?: WandTaskAgent;
  /** 该 provider 当前生效的服务端默认模型，仅作展示（agent.model 仍是 "default"）。 */
  defaultModel?: string;
  reason?: string;
}

/**
 * 两端唯一的默认解析：已保存的员工创建配置 → 服务端 defaultProvider/defaultModel → 需要用户选择。
 * 纯函数；saved 的解析（parseTaskAgent 等）由调用方完成后传入。
 */
export function resolveSiliconEmployeeDefaults(input: {
  savedAgent?: WandTaskAgent | null;
  config?: EmployeeDefaultsConfig;
}): SiliconEmployeeDefaults {
  const saved = input.savedAgent;
  if (saved && saved.kind === "structured" && isSessionProvider(saved.provider)) {
    return {
      configured: true,
      requiresUserChoice: false,
      source: "saved",
      provider: saved.provider,
      agent: saved,
      defaultModel: getDefaultModelForProvider(input.config ?? {}, saved.provider),
    };
  }
  const provider = input.config?.defaultProvider;
  if (provider && isSessionProvider(provider)) {
    return {
      configured: true,
      requiresUserChoice: false,
      source: "server",
      provider,
      agent: employeeAgentFor(provider),
      defaultModel: getDefaultModelForProvider(input.config ?? {}, provider),
    };
  }
  return {
    configured: false,
    requiresUserChoice: true,
    reason: "服务端未配置默认执行工具，请在创建员工时自行选择执行配置。",
  };
}
