import assert from "node:assert/strict";
import test from "node:test";
import { taskExecutors, taskExecutorToolLabels } from "../src/web-ui/react/issues/task-executors.js";
import type { IssueSessionSummary } from "../src/web-ui/react/issues/task-board-repository.js";
const session = (id: string, employeeId?: string, status = "idle"): IssueSessionSummary => ({ id, employeeId, employeeName: employeeId ? employeeId : undefined, provider: "pi", title: id, status, sessionKind: "structured", cwd: "/tmp", model: "m", thinkingEffort: "off" });
test("执行者按稳定员工身份聚合，当前负责人优先，区分实际执行、历史与计划", () => {
  const people = taskExecutors([session("a", "e1", "running"), session("b", "e1"), session("c", "e2"), session("d")], null, { type: "employee", id: "e3" }, [{ id: "e1", name: "员工一", avatar: "cat:1" }, { id: "e3", name: "员工三" }]);
  assert.equal(people.length, 4);
  assert.equal(people[0]!.name, "员工三");
  assert.equal(people[0]!.state, "assigned");
  assert.equal(people[1]!.name, "员工一");
  assert.equal(people[1]!.sessions.length, 2);
  assert.equal(people[1]!.state, "running");
  assert.equal(people[2]!.state, "history");
  assert.equal(people[3]!.name, "Pi");
  assert.equal(people[3]!.employeeId, undefined);
  assert.deepEqual(taskExecutors([], null), []);
});

test("员工目录不可用时，匹配稳定 ID 的负责人投影保留姓名与头像", () => {
  const s = { ...session("a", "e1", "running"), employeeName: undefined, employeeAvatar: undefined };
  const [person] = taskExecutors([s], null, { type: "employee", id: "e1" }, [], { id: "e1", name: "赛博虎妞", avatar: "cat:1" });
  assert.equal(person!.name, "赛博虎妞");
  assert.equal(person!.avatar, "cat:1");
  assert.deepEqual(taskExecutorToolLabels(person!), ["Pi"]);
  assert.equal(person!.sessions[0], s, "identity projection does not mutate execution records");
});

test("缺失资料的员工仍是员工，不冒充 Pi；后续完整快照补齐同身份的历史记录", () => {
  const sparse = { ...session("a", "e1"), employeeName: undefined };
  assert.equal(taskExecutors([sparse], null)[0]!.name, "员工（资料不可用）");
  const full = { ...session("b", "e1"), employeeName: "历史员工", employeeAvatar: "cat:3" };
  const [person] = taskExecutors([sparse, full], null);
  assert.equal(person!.name, "历史员工");
  assert.equal(person!.avatar, "cat:3");
  assert.equal(person!.sessions.length, 2);
});

test("当前员工配置优先，缺头像回退快照，Pi CLI 与 SDK 只是次级工具", () => {
  const cli = { ...session("a", "e1"), employeeAvatar: "cat:2" };
  const sdk = { ...session("b", "e1"), engine: "sdk" as const };
  const [person] = taskExecutors([cli, sdk], null, null, [{ id: "e1", name: "新姓名" }]);
  assert.equal(person!.name, "新姓名");
  assert.equal(person!.avatar, "cat:2");
  assert.deepEqual(taskExecutorToolLabels(person!), ["Pi", "Wand Agent"]);
});

test("重新指派不改写历史 CLI 或其他员工，当前负责人不会被三个历史执行者折叠", () => {
  const history = [session("cli"), session("old", "old"), session("other", "other")];
  const people = taskExecutors(history, { provider: "pi", model: "fixture" }, { type: "employee", id: "new" }, [], { id: "new", name: "新负责人", avatar: "cat:4" });
  assert.equal(people[0]!.name, "新负责人");
  assert.equal(people[0]!.sessions.length, 0);
  assert.equal(people[1]!.name, "Pi");
  assert.equal(people[1]!.employeeId, undefined);
  assert.equal(people[2]!.name, "old");
  assert.equal(people[3]!.name, "other");
  assert.deepEqual(people.slice(1).flatMap(p => p.sessions), history);
});
