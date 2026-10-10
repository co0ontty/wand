import { defaultEmployeeDefinition } from "./default-employee.js";
import { AI_TEAM_MAX_CANDIDATES, agentKey, isDefaultSiliconEmployee, type AiTeam, type AiTeamMember, type SiliconEmployee } from "./ai-team-types.js";

export interface AiTeamEmployeeSource {
  getSiliconEmployee(id: string): SiliconEmployee | null;
  getSiliconEmployeeDefinition?(id: string): SiliconEmployee | null;
}

// Execution-only data: never enumerable on a member or exposed by public DTO serialization.
const snapshots = new WeakMap<AiTeamMember, SiliconEmployee>();

function employeeSnapshot(employee: SiliconEmployee): SiliconEmployee {
  return {
    id: employee.id, name: employee.name, avatar: employee.avatar, prompt: employee.prompt,
    duty: employee.duty, agents: employee.agents.map((agent) => ({ ...agent })),
    createdAt: employee.createdAt, updatedAt: employee.updatedAt,
  };
}

export function teamMemberEmployee(member: AiTeamMember): SiliconEmployee | undefined {
  return snapshots.get(member);
}

/** Only storage restores this private field; HTTP parsing deliberately ignores it. */
export function restoreTeamMemberEmployee(member: AiTeamMember, employee: SiliconEmployee): void {
  if (member.employeeId && employee.id === member.employeeId) {
    snapshots.set(member, employeeSnapshot(employee));
  }
}

export function requireTeamEmployee(source: AiTeamEmployeeSource, id: string): SiliconEmployee {
  const employee = source.getSiliconEmployee(id);
  if (!employee) throw new Error("绑定的员工不存在。");
  if (employee.archivedAt) throw new Error(`员工「${employee.name}」已归档，不能加入团队或新开工。`);
  if (!employee.agents.length || employee.agents.length > AI_TEAM_MAX_CANDIDATES
    || employee.agents.some((agent) => agent.kind !== "structured")
    || new Set(employee.agents.map(agentKey)).size !== employee.agents.length) {
    throw new Error(`员工「${employee.name}」需要有效且不重复的结构化 CLI 候选。`);
  }
  // The default partner's read projection includes short-term habits; they are not team snapshot data.
  return isDefaultSiliconEmployee(employee)
    ? defaultEmployeeDefinition(employee.agents, employee.updatedAt, source.getSiliconEmployeeDefinition?.(id) ?? employee, null)
    : employee;
}

/** Resolve once per new run. Team duty/role/leadership remain local; no knowledge is read. */
export function freezeTeamEmployees(team: AiTeam, source: AiTeamEmployeeSource): AiTeam {
  const seen = new Set<string>();
  return {
    ...team,
    members: team.members.map((member) => {
      if (!member.employeeId) return { ...member, agents: member.agents.map((agent) => ({ ...agent })) };
      if (seen.has(member.employeeId)) throw new Error("同一员工不能重复加入同一团队。");
      seen.add(member.employeeId);
      const employee = requireTeamEmployee(source, member.employeeId);
      const snapshot = employeeSnapshot(employee);
      const frozen = { ...member, name: snapshot.name, avatar: snapshot.avatar,
        agents: snapshot.agents, agent: snapshot.agents[0]! };
      snapshots.set(frozen, snapshot);
      return frozen;
    }),
  };
}

/** Private persisted snapshot is explicitly written only to ai_team_runs.team_json. */
export function serializeExecutionTeam(team: AiTeam): string {
  return JSON.stringify({ ...team, members: team.members.map((member) => ({
    ...member, _employeeSnapshot: snapshots.get(member),
  })) });
}

/** Team definitions expose current employee-owned fields without storing another copy of the role. */
export function projectTeamDefinition(team: AiTeam, source: AiTeamEmployeeSource): AiTeam {
  return { ...team, members: team.members.map((member) => {
    const employee = member.employeeId ? source.getSiliconEmployee(member.employeeId) : null;
    return employee ? { ...member, name: employee.name, avatar: employee.avatar,
      agents: employee.agents, agent: employee.agents[0]! } : member;
  }) };
}

/** Read-only names/avatars follow the same employee, never a replacement at the same member id. */
export function projectTeamEmployees(team: AiTeam, source: AiTeamEmployeeSource): AiTeam {
  return { ...team, members: team.members.map((member) => {
    const employee = member.employeeId ? source.getSiliconEmployee(member.employeeId) : null;
    return employee ? { ...member, name: employee.name, avatar: employee.avatar } : member;
  }) };
}
