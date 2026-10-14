import type { SiliconEmployee } from "./ai-team-types.js";
import { providerCliInstalled } from "./session-provider.js";
import type { WandTaskAgent } from "./task-types.js";
import { isLocalDecisionModel } from "./decision-expert-identity.js";

/** Match child-process PATH without starting a shell or trusting a client availability claim. */
export function employeeCliAvailable(agent: WandTaskAgent, pathValue = process.env.PATH ?? ""): boolean {
  return providerCliInstalled(agent.provider, pathValue);
}

/** SDK runs in-process; its availability is decided by the harness, not by a CLI executable. */
export function employeeCandidateAvailable(agent: WandTaskAgent): boolean {
  return agent.engine === "sdk" || employeeCliAvailable(agent);
}

/** First available candidate wins; when none is available retain the preferred candidate for a recoverable failure. */
export function selectEmployeeCandidate(
  employee: Pick<SiliconEmployee, "agents">,
  available: (agent: WandTaskAgent) => boolean = employeeCandidateAvailable,
): { agent: WandTaskAgent; index: number } {
  // LAYA is invoked only by the bounded decision evaluator; never pass its selector to a chat CLI/harness.
  const candidates = employee.agents.filter((agent) => !isLocalDecisionModel(agent.model));
  if (!candidates.length) throw new Error("LAYA 仅支持有界决策，员工没有可用的对话候选；请配置备用调用链。");
  if (candidates.some((agent) => agent.kind !== "structured")) {
    throw new Error("硅基员工没有可用的结构化执行候选。");
  }
  const index = candidates.findIndex((agent) => available(agent));
  const selectedIndex = index < 0 ? 0 : index;
  const agent = candidates[selectedIndex]!;
  const originalIndex = employee.agents.indexOf(agent);
  return { agent, index: originalIndex };
}
