import assert from "node:assert/strict";
import test from "node:test";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import type { WandTaskAgent } from "../src/task-types.js";
import { HttpResponseError } from "../src/web-ui/react/http-adapter.js";
import { bindTeamEmployee, duplicateTeamEmployees, employeeJoinError, teamRequestInput,
  teamSaveDefinitelyRejected, type TeamMemberDraft } from "../src/web-ui/react/ai-teams/team-employee-binding.js";
import { validateTeamDraft } from "../src/web-ui/react/ai-teams/teams-page.js";

const agent: WandTaskAgent = { provider: "codex", model: "default", mode: "default",
  thinkingEffort: "default", kind: "structured" };
const member: TeamMemberDraft = { id: "m_1", name: "CLI", duty: "审查", role: "verify",
  isLeader: true, agents: [agent], agent, avatar: "cat:0" };
const employee: SiliconEmployee = { id: "e_1", name: "通讯录员工", duty: "基础职责", prompt: "私有人设",
  agents: [{ ...agent, provider: "pi" }], avatar: "cat:2", createdAt: "", updatedAt: "" };

test("employee binding preserves team member id/duty/role/leader without importing private material", () => {
  const linked = bindTeamEmployee(member, employee);
  assert.equal(linked.employeeId, employee.id);
  assert.equal(linked.name, employee.name);
  assert.equal(linked.avatar, employee.avatar);
  for (const field of ["id", "duty", "role", "isLeader"] as const) assert.equal(linked[field], member[field]);
  assert.deepEqual(linked.agents, employee.agents);
  assert.notEqual(linked.agents, employee.agents);
  assert.notEqual(linked.agent, employee.agents[0]);
  assert.equal("prompt" in linked, false);
  assert.equal(member.employeeId, undefined);
});

test("binding or replacing an existing member preserves an intentionally empty team duty", () => {
  const emptyDuty = { ...member, duty: "" };
  assert.equal(bindTeamEmployee(emptyDuty, employee).duty, "");
  const previouslyBound = { ...emptyDuty, employeeId: "e_previous" };
  assert.equal(bindTeamEmployee(previouslyBound, employee).duty, "");
});

test("invitation rejects duplicate IDs, archived employees and non-structured or empty candidates", () => {
  const linked = bindTeamEmployee(member, employee);
  assert.equal(employeeJoinError(employee, [linked]), "已在团队中");
  assert.equal(employeeJoinError(employee, [linked], 0), null);
  assert.equal(employeeJoinError({ ...employee, archivedAt: "today" }, []), "已归档");
  assert.equal(employeeJoinError({ ...employee, agents: [] }, []), "需要结构化 CLI 候选");
  assert.equal(employeeJoinError({ ...employee, agents: [{ ...agent, kind: "pty" }] }, []), "需要结构化 CLI 候选");
  assert.equal(employeeJoinError({ ...employee, id: "e_2" }, [linked]), null, "same name is not identity");
  assert.deepEqual(duplicateTeamEmployees([linked, { ...linked, id: "m_2" }]), [employee.name]);
  assert.ok(validateTeamDraft([linked, { ...linked, id: "m_2", isLeader: false }]).some((error) => error.includes("重复")));
  assert.deepEqual(duplicateTeamEmployees([member, { ...member, employeeId: null }]), []);
});

test("request preserves employee ID, omitted legacy binding and explicit null unlink", () => {
  const input = { name: "团队", description: "", instructions: "", requirePlanApproval: true,
    maxSteps: 30, members: [bindTeamEmployee(member, employee), member, { ...member, employeeId: null }] };
  const wire = JSON.parse(JSON.stringify(teamRequestInput(input)));
  assert.equal(wire.members[0].employeeId, "e_1");
  assert.equal("employeeId" in wire.members[1], false);
  assert.equal(wire.members[2].employeeId, null);
});

test("unknown save responses prohibit blind retries, only explicit rejection unlocks save", () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(teamSaveDefinitelyRejected(new HttpResponseError("bad", status)), true);
  for (const status of [0, 200, 408, 409, 500, 503]) assert.equal(teamSaveDefinitelyRejected(new HttpResponseError("unknown", status)), false);
  assert.equal(teamSaveDefinitelyRejected(new Error("timeout")), false);
});
