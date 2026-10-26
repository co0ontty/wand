import assert from "node:assert/strict";
import test from "node:test";
import { taskCreationRequest, unknownTaskCreation, type TaskCreationDraft } from "../src/web-ui/react/issues/task-create-state.js";

const draft: TaskCreationDraft = {
  workspaceId: "project", cwd: "/project", title: " 目标 ", status: "doing", priority: "high", dueDate: "2028-02-29",
  labels: " frontend，验收, ", milestoneId: "iteration", parentTaskId: "parent",
  agent: { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" },
  subject: { type: "employee", id: "employee" }, employeeOverride: false,
};

test("task creation preserves all metadata independently of execution and optional title", () => {
  const request = taskCreationRequest({ ...draft, title: "" }, " 交付目标 ", true);
  assert.deepEqual(request, { workspaceId: "project", title: "", description: "交付目标", status: "doing", priority: "high",
    dueDate: "2028-02-29", labels: ["frontend", "验收"], milestoneId: "iteration", parentTaskId: "parent",
    executionSubject: { type: "employee", id: "employee" }, rememberAgentDefaults: false });
  assert.equal("dispatch" in request, false, "business status cannot request execution");
});

test("employee override is scoped to this task and defaults require explicit CLI selection", () => {
  const overridden = taskCreationRequest({ ...draft, employeeOverride: true }, "目标", true);
  assert.deepEqual(overridden.executionSubject, { type: "employee", id: "employee", agentOverride: draft.agent });
  assert.equal("agent" in overridden, false);
  assert.equal(overridden.rememberAgentDefaults, false);
  assert.deepEqual(taskCreationRequest({ ...draft, subject: { ...draft.subject, agentOverride: { ...draft.agent, model: "old-override" } } }, "目标", false).executionSubject,
    { type: "employee", id: "employee" }, "restoring employee defaults removes the old override snapshot");
  const cli = { ...draft, subject: { type: "cli" as const, id: "claude" } };
  assert.equal(taskCreationRequest(cli, "目标", false).rememberAgentDefaults, false);
  assert.equal(taskCreationRequest(cli, "目标", true).rememberAgentDefaults, true);
  assert.deepEqual(taskCreationRequest(cli, "目标", true).agent, draft.agent);
});

test("unknown create acceptance never becomes a retryable failure", () => {
  for (const status of [0, 200, 201, 408, 409, 500, 502, 503]) assert.equal(unknownTaskCreation({ status }), true, String(status));
  for (const status of [400, 401, 403, 404, 422, 429]) assert.equal(unknownTaskCreation({ status }), false, String(status));
  assert.equal(unknownTaskCreation(new Error("transport failed")), true);
});
