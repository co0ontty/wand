import type { SiliconEmployee } from "./ai-team-types.js";
import { providerCliInstalled } from "./session-provider.js";
import type { WandTaskAgent } from "./task-types.js";

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
  const candidates = options.skipSdk ? employee.agents.filter((agent) => agent.engine !== "sdk") : employee.agents;
  if (!candidates.length) throw new Error("硅基员工没有可用的 CLI 执行候选。");
  if (!candidates.length || candidates.some((agent) => agent.kind !== "structured")) {
    throw new Error("硅基员工没有可用的结构化执行候选。");
  }
  const index = candidates.findIndex((agent) => available(agent));
  const selectedIndex = index < 0 ? 0 : index;
  const agent = candidates[selectedIndex]!;
  const originalIndex = employee.agents.indexOf(agent);
  return { agent, index: originalIndex };
}
