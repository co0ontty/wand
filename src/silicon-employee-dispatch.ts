import type { SiliconEmployee } from "./ai-team-types.js";
import { providerCliInstalled } from "./session-provider.js";
import type { WandTaskAgent } from "./task-types.js";
import { isLocalDecisionModel } from "./decision-expert-identity.js";

export interface EmployeeCandidateSelectionOptions {
  /** 普通任务派发只走 CLI；显式员工会话可允许已配置的 SDK。 */
  skipSdk?: boolean;
}

/** Match child-process PATH without starting a shell or trusting a client availability claim. */
export function employeeCliAvailable(agent: WandTaskAgent, pathValue = process.env.PATH ?? ""): boolean {
  return providerCliInstalled(agent.provider, pathValue);
}

/** First installed candidate wins; when none is installed retain the preferred candidate for a recoverable failure. */
export function selectEmployeeCandidate(
  employee: Pick<SiliconEmployee, "agents">,
  available: (agent: WandTaskAgent) => boolean = employeeCliAvailable,
  options: EmployeeCandidateSelectionOptions = {},
): { agent: WandTaskAgent; index: number } {
  // LAYA is invoked only by the bounded decision evaluator; never pass its selector to a chat CLI/harness.
  const generative = employee.agents.filter((agent) => !isLocalDecisionModel(agent.model));
  const candidates = options.skipSdk ? generative.filter((agent) => agent.engine !== "sdk") : generative;
  if (!candidates.length) throw new Error("LAYA 仅支持有界决策，或员工没有可用 CLI 候选；请配置「决策专家」备用调用链。");
  if (!candidates.length || candidates.some((agent) => agent.kind !== "structured")) {
    throw new Error("硅基员工没有可用的结构化执行候选。");
  }
  const index = candidates.findIndex((agent) => available(agent));
  const selectedIndex = index < 0 ? 0 : index;
  const agent = candidates[selectedIndex]!;
  const originalIndex = employee.agents.indexOf(agent);
  return { agent, index: originalIndex };
}
