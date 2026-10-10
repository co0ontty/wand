import assert from "node:assert/strict";
import test from "node:test";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import { FIXED_EMPLOYEE_AVATARS } from "../src/fixed-employee-avatar.js";
import { employeeUpdateInput } from "../src/web-ui/react/agents/employee-repository.js";

const now = "2026-10-10T00:00:00.000Z";
const agents: SiliconEmployee["agents"] = [{ provider: "pi", engine: "sdk", kind: "structured", mode: "managed", model: "first" }];
const changedAgents: SiliconEmployee["agents"] = [{ provider: "codex", engine: "cli", kind: "structured", mode: "managed", model: "second" }];
function employee(patch: Partial<SiliconEmployee> = {}): SiliconEmployee {
  return { id: "e_regular", name: "普通员工", duty: "原职责", prompt: "原角色\n近期使用偏好：动态生成的上下文", avatar: "cat:2",
    agents, tags: ["研发"], createdAt: now, updatedAt: now, ...patch };
}
function completeInput(value: SiliconEmployee) {
  return { name: value.name, duty: value.duty, prompt: value.prompt, avatar: value.avatar, tags: value.tags ?? [], agents: value.agents };
}

test("both exact fixed employee identity pairs send only explicitly changed editable fields", () => {
  for (const identity of FIXED_EMPLOYEE_AVATARS) {
    const current = employee(identity);
    const patch: Partial<SiliconEmployee> = { name: "新名字", duty: "新职责", prompt: "新角色", agents: changedAgents,
      avatar: "cat:9", id: "e_replacement", systemKey: "replacement", tags: ["替换标签"], archivedAt: now };
    const before = structuredClone({ current, patch });
    assert.deepEqual(employeeUpdateInput(current, patch), { name: "新名字", duty: "新职责", prompt: "新角色", agents: changedAgents });
    assert.deepEqual({ current, patch }, before, "building update parameters must preserve both caller inputs");
  }
});

test("a fixed employee name-only edit does not echo generated prompt or other unchanged data", () => {
  for (const identity of FIXED_EMPLOYEE_AVATARS) {
    const current = employee(identity);
    assert.deepEqual(employeeUpdateInput(current, { name: "只改名字" }), { name: "只改名字" });
    assert.deepEqual(employeeUpdateInput(current, {}), {});
    assert.deepEqual(employeeUpdateInput(current, { duty: "", prompt: "", agents: changedAgents }), { duty: "", prompt: "", agents: changedAgents });
    assert.deepEqual(employeeUpdateInput(current, { name: undefined, duty: undefined, prompt: undefined, agents: undefined }), {});
  }
});

test("ordinary employees sharing fixed names or only one identity field keep complete update inputs", () => {
  for (const identity of FIXED_EMPLOYEE_AVATARS) {
    for (const current of [employee({ name: identity.systemKey === "wand-default" ? "赛博虎妞" : "勤劳的初二" }),
      employee({ id: identity.id }), employee({ id: identity.id, systemKey: "custom-role" })]) {
      assert.deepEqual(employeeUpdateInput(current, { name: "改名" }), { ...completeInput(current), name: "改名" });
    }
  }
});

test("a mismatched fixed identity with a recognized built-in key retains the existing agents-only policy", () => {
  for (const identity of FIXED_EMPLOYEE_AVATARS) {
    const current = employee({ id: "e_other", systemKey: identity.systemKey });
    assert.deepEqual(employeeUpdateInput(current, { name: "改名", prompt: "改角色", avatar: "cat:9", tags: [], agents: changedAgents }), { agents: changedAgents });
    assert.deepEqual(employeeUpdateInput(current, { name: "改名" }), { agents });
  }
});

test("other built-in employees still send only agents, retaining current candidates when omitted", () => {
  for (const systemKey of ["wand-decision-expert", "wand-speech-polisher"]) {
    const current = employee({ systemKey });
    assert.deepEqual(employeeUpdateInput(current, { name: "改名", duty: "新职责", prompt: "新角色", avatar: "cat:9", tags: [], agents: changedAgents }), { agents: changedAgents });
    assert.deepEqual(employeeUpdateInput(current, { prompt: "新角色" }), { agents });
  }
});

test("ordinary employee saves include all editable fields and default absent tags to an empty list", () => {
  const current = employee({ tags: undefined });
  assert.deepEqual(employeeUpdateInput(current, {}), completeInput(current));
  assert.deepEqual(employeeUpdateInput(current, { name: "新名字", duty: "", prompt: "新角色", avatar: "", tags: [], agents: changedAgents,
    id: "e_replacement", systemKey: "replacement" }), { name: "新名字", duty: "", prompt: "新角色", avatar: "", tags: [], agents: changedAgents });
});
