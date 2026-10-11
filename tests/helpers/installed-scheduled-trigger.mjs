import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Exercise the installed timer with an archived probe employee. The normal
 * employee guard must reject before a model/session is created. Only this
 * probe's new employee and schedule are mutated; credentials stay in memory. */
export async function verifyInstalledScheduledTrigger({ originOverride } = {}) {
  const { request } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(path.join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = originOverride ?? new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const token = decoded.slice(decoded.lastIndexOf("#") + 1);
  const client = await request.newContext({ baseURL: origin });
  let employeeId, taskId;
  try {
    assert.equal((await client.post("/api/login", { data: { appToken: token } })).status(), 200);
    const workspaceBody = await (await client.get("/api/workspaces")).json();
    const workspaces = Array.isArray(workspaceBody) ? workspaceBody : workspaceBody.workspaces;
    const workspace = workspaces.find(item => item.kind !== "global" && item.cwd);
    assert.ok(workspace, "Need one configured workspace for scheduled-trigger acceptance");
    const label = `定时触发验收-${randomUUID().slice(0, 8)}`;
    const employeeResponse = await client.post("/api/silicon-employees", { data: {
      name: label, duty: "验证归档员工阻断定时执行", prompt: "仅用于本轮定时触发验收。", avatar: "", tags: [],
      agents: [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured", engine: "sdk" }],
    } });
    assert.equal(employeeResponse.status(), 201);
    employeeId = (await employeeResponse.json()).id;
    const runAt = new Date(Date.now() + 30_000).toISOString();
    const response = await client.post("/api/scheduled-tasks", { data: { requestId: randomUUID(), title: label,
      employeeId, workspaceId: workspace.id, prompt: "此员工应在触发前已归档，执行必须明确拒绝且不得创建模型会话。", schedule: { kind: "once", runAt } } });
    assert.equal(response.status(), 201);
    const saved = await response.json(); taskId = saved.task.id;
    assert.equal(saved.task.workspaceId, workspace.id);
    assert.equal(saved.task.workspaceCwd, workspace.cwd);
    assert.equal((await client.post(`/api/silicon-employees/${employeeId}/archive`)).status(), 200);
    let detail;
    const deadline = Date.now() + 65_000;
    while (Date.now() < deadline) {
      const result = await client.get(`/api/scheduled-tasks/${taskId}`);
      assert.equal(result.status(), 200);
      detail = await result.json();
      if (detail.runs.length) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(detail.runs.length, 1, "installed timer claimed exactly one due occurrence");
    assert.equal(detail.runs[0].state, "rejected");
    assert.equal(detail.runs[0].executionStatus, "failed");
    assert.equal(detail.runs[0].sessionId, null, "archived employee guard rejected before any model session");
    assert.match(detail.runs[0].error, /归档/);
    assert.equal(detail.runs[0].workspaceId, workspace.id);
    assert.equal(detail.runs[0].cwd, workspace.cwd, "trigger history freezes the chosen execution directory");
    assert.equal(detail.task.enabled, false);
    assert.equal(detail.task.nextRunAt, null);
    const result = { installed: true, timerTriggered: true, occurrences: 1, unavailableEmployeeRejected: true,
      failedHistoryRecorded: true, selectedWorkspaceCaptured: true, executionDirectoryRecorded: true,
      sessionCreated: false, modelExecution: false };
    const evidence = "output/architecture-stage2/scheduled-tasks-installed";
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, "trigger-result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    try {
      if (taskId) {
        const response = await client.get(`/api/scheduled-tasks/${taskId}`);
        if (response.status() === 200) {
          const { task } = await response.json();
          if (!task.cancelledAt) assert.equal((await client.patch(`/api/scheduled-tasks/${taskId}`,
            { data: { revision: task.revision, cancelled: true } })).status(), 200);
        }
      }
      if (employeeId) assert.equal((await client.delete(`/api/silicon-employees/${employeeId}`)).status(), 204);
      assert.equal((await client.post("/api/logout")).status(), 200);
    } finally { await client.dispose(); }
  }
}
