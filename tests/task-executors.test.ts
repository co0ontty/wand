import assert from "node:assert/strict";
import test from "node:test";
import { taskExecutors } from "../src/web-ui/react/issues/task-executors.js";
import type { IssueSessionSummary } from "../src/web-ui/react/issues/task-board-repository.js";
const session = (id: string, employeeId?: string, status = "idle"): IssueSessionSummary => ({ id, employeeId, employeeName: employeeId ? employeeId : undefined, provider: "pi", title: id, status, sessionKind: "structured", cwd: "/tmp", model: "m", thinkingEffort: "off" });
test("执行者按稳定员工身份聚合，区分实际执行、历史与计划", () => {
  const people = taskExecutors([session("a", "e1", "running"), session("b", "e1"), session("c", "e2"), session("d")], null, { type: "employee", id: "e3" }, [{ id: "e1", name: "员工一", avatar: "cat:1" }, { id: "e3", name: "员工三" }]);
  assert.equal(people.length, 4);
  assert.equal(people[0]!.name, "员工一");
  assert.equal(people[0]!.sessions.length, 2);
  assert.equal(people[0]!.state, "running");
  assert.equal(people[1]!.state, "history");
  assert.equal(people[2]!.name, "Pi");
  assert.equal(people[2]!.employeeId, undefined);
  assert.equal(people[3]!.state, "assigned");
  assert.deepEqual(taskExecutors([], null), []);
});
