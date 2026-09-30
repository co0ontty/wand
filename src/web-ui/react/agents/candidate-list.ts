import { AI_TEAM_MAX_CANDIDATES, agentKey } from "../../../ai-team-types.js";
import { createDefaultIssueAgent } from "../issues/task-board-agent.js";
import type { WandTaskAgent } from "../../../task-types.js";

/** 候选行标题：第一行是首选，其余按降级顺序编号。 */
export function candidateLabel(index: number): string {
  return index === 0 ? "首选" : `备用 ${index + 1}`;
}

/** 加一个候选：复制末位配置作为起点，重复由校验逼着改掉；到上限原样返回。 */
export function addCandidate(agents: WandTaskAgent[]): WandTaskAgent[] {
  if (agents.length >= AI_TEAM_MAX_CANDIDATES) return agents;
  const last = agents[agents.length - 1];
  return [...agents, last ? { ...last } : createDefaultIssueAgent()];
}

export function setCandidate(agents: WandTaskAgent[], index: number, agent: WandTaskAgent): WandTaskAgent[] {
  return agents.map((item, at) => (at === index ? { ...agent } : item));
}

/** 删一个候选：最后一个不许删（每成员/员工至少 1 个候选）。 */
export function removeCandidate(agents: WandTaskAgent[], index: number): WandTaskAgent[] {
  if (agents.length <= 1) return agents;
  return agents.filter((_, at) => at !== index);
}

/** 上移 / 下移一位；越界原样返回（顺序即降级顺序）。 */
export function moveCandidate(agents: WandTaskAgent[], index: number, delta: number): WandTaskAgent[] {
  const target = index + delta;
  if (target < 0 || target >= agents.length) return agents;
  const next = [...agents];
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/** 与更靠前的候选五元组相同的行下标。 */
export function duplicateCandidates(agents: WandTaskAgent[]): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  agents.forEach((agent, index) => {
    const key = agentKey(agent);
    if (seen.has(key)) duplicates.push(index);
    else seen.add(key);
  });
  return duplicates;
}

/** 一个成员或员工的候选列表自身的错误，空串表示没问题。 */
export function candidateListError(agents: WandTaskAgent[]): string {
  if (agents.length === 0) return "至少保留 1 个执行候选。";
  if (agents.length > AI_TEAM_MAX_CANDIDATES) return `执行候选最多 ${AI_TEAM_MAX_CANDIDATES} 个。`;
  const duplicates = duplicateCandidates(agents);
  if (duplicates.length > 0) {
    return `候选「${candidateLabel(duplicates[0]!)}」与更靠前的配置相同，改一项即可。`;
  }
  return "";
}
