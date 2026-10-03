import type { AiTeamMember, SiliconEmployee } from "../../../ai-team-types.js";
import type { AiTeamInput } from "./repository.js";
import { HttpResponseError } from "../http-adapter.js";

/** null is a write-only unlink instruction; omission preserves older clients' bindings. */
export type TeamMemberDraft = Omit<AiTeamMember, "employeeId"> & { employeeId?: string | null };
export type TeamDraftInput = Omit<AiTeamInput, "members"> & { members: TeamMemberDraft[] };

export function employeeJoinError(
  employee: SiliconEmployee,
  members: readonly TeamMemberDraft[],
  replacingIndex = -1,
): string | null {
  if (employee.archivedAt) return "已归档";
  if (!employee.agents.length || employee.agents.some((agent) => agent.kind !== "structured")) {
    return "需要结构化 CLI 候选";
  }
  if (members.some((member, index) => index !== replacingIndex && member.employeeId === employee.id)) {
    return "已在团队中";
  }
  return null;
}

/** Only employee-owned identity/candidates are projected; team duty/role/leadership survive. */
export function bindTeamEmployee(member: TeamMemberDraft, employee: SiliconEmployee): TeamMemberDraft {
  const agents = employee.agents.map((agent) => ({ ...agent }));
  return { ...member, employeeId: employee.id, name: employee.name, avatar: employee.avatar,
    agents, agent: { ...agents[0]! } };
}

export function duplicateTeamEmployees(members: readonly TeamMemberDraft[]): string[] {
  const seen = new Set<string>();
  return members.flatMap((member) => {
    if (!member.employeeId) return [];
    if (seen.has(member.employeeId)) return [member.name || member.employeeId];
    seen.add(member.employeeId);
    return [];
  });
}

/** Keep null on the wire without widening the shared read DTO or repository contract. */
export function teamRequestInput(draft: TeamDraftInput): AiTeamInput {
  return draft as AiTeamInput;
}

export function teamSaveDefinitelyRejected(cause: unknown): boolean {
  return cause instanceof HttpResponseError && cause.status >= 400 && cause.status < 500
    && cause.status !== 408 && cause.status !== 409;
}
