import assert from "node:assert/strict";
import test from "node:test";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import { employeeUpdateInput } from "../src/web-ui/react/agents/employee-repository.js";

const now = "2026-10-18T00:00:00.000Z";
const agents: SiliconEmployee["agents"] = [{ provider: "pi", engine: "sdk", kind: "structured", mode: "managed", model: "first" }];
function employee(patch: Partial<SiliconEmployee> = {}): SiliconEmployee {
  return { id: "e_regular", name: "普通员工", duty: "职责", prompt: "角色", avatar: "cat:2",
    agents, tags: ["研发"], createdAt: now, updatedAt: now, ...patch };
}

test("ordinary employee save passes systemSessionLimit through: number, null, and omitted", () => {
  const current = employee();
  // 明确设置保留上限：发送数字。
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: 50 }).systemSessionLimit, 50);
  // 0 = 不保留已结束记录，必须原样发送而不是被当成 falsy 丢弃。
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: 0 }).systemSessionLimit, 0);
  // null = 关闭清理（不限）。
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: null }).systemSessionLimit, null);
  // 本次未动该字段且员工也没有旧值：PUT 省略，服务端保留旧值。
  assert.ok(!("systemSessionLimit" in employeeUpdateInput(current, { name: "改名" })));
});

test("ordinary employee with an existing limit re-sends it on unrelated edits (full-input contract)", () => {
  const current = employee({ systemSessionLimit: 200 });
  assert.equal(employeeUpdateInput(current, { name: "改名" }).systemSessionLimit, 200);
  // 显式 null 覆盖已有值以关闭清理。
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: null }).systemSessionLimit, null);
});

test("builtin employees send explicit retention edits without locked fields", () => {
  const current = employee({ systemKey: "wand-decision-expert" });
  const input = employeeUpdateInput(current, { systemSessionLimit: 10, agents });
  assert.deepEqual(input, { agents, systemSessionLimit: 10 });
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: null }).systemSessionLimit, null);
});

test("fixed-avatar employees send systemSessionLimit only when explicitly changed", () => {
  const current = employee({ id: "e_wand_default", systemKey: "wand-default" });
  assert.ok(!("systemSessionLimit" in employeeUpdateInput(current, { name: "只改名字" })));
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: 3 }).systemSessionLimit, 3);
  assert.equal(employeeUpdateInput(current, { systemSessionLimit: null }).systemSessionLimit, null);
});
