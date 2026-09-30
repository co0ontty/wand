import type { SiliconEmployee } from "./ai-team-types.js";
import { providerCliInstalled } from "./session-provider.js";
import type { WandTaskAgent } from "./task-types.js";

/** Match child-process PATH without starting a shell or trusting a client availability claim. */
export function employeeCliAvailable(agent: WandTaskAgent, pathValue = process.env.PATH ?? ""): boolean {
  return providerCliInstalled(agent.provider, pathValue);
}

/** First installed candidate wins; when none is installed retain the preferred candidate for a recoverable failure. */
export function selectEmployeeCandidate(
  employee: Pick<SiliconEmployee, "agents">,
  available: (agent: WandTaskAgent) => boolean = employeeCliAvailable,
): { agent: WandTaskAgent; index: number } {
  if (!employee.agents.length || employee.agents.some((agent) => agent.kind !== "structured")) {
    throw new Error("硅基员工没有可用的结构化执行候选。");
  }
  const index = employee.agents.findIndex((agent) => available(agent));
  return { agent: employee.agents[index < 0 ? 0 : index]!, index: index < 0 ? 0 : index };
}
