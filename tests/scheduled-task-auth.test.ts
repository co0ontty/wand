import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

test("scheduled task routes require login and the sessions scope before accessing prompts or creating work", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-schedule-auth-"));
  const previous = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.WAND_TEST_MODE; else process.env.WAND_TEST_MODE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const password = "schedule-auth-test-password", appSecret = "schedule-auth-test-secret";
  const server = await startServer({ ...defaultConfig(), host: "127.0.0.1", port: 0, https: false,
    password, appSecret, defaultCwd: root, startupCommands: [] }, join(root, "config.json"));
  t.after(() => server.close());
  const origin = server.urls[0]!.url;
  const fileSession = server.authService.createSession({ kind: "connected-app", scopes: ["files"] });
  for (const [method, route] of [["GET", "/api/scheduled-tasks"], ["GET", "/api/scheduled-tasks/missing"],
    ["GET", "/api/scheduled-tasks/calendar?from=2030-01-01&to=2030-01-31&timeZone=UTC"],
    ["GET", "/api/scheduled-tasks/missing/activity?timeZone=UTC"], ["GET", "/api/scheduled-tasks/missing/runs/missing"],
    ["POST", "/api/scheduled-tasks"], ["PATCH", "/api/scheduled-tasks/missing"]]) {
    const request = { method, ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}) };
    assert.equal((await fetch(origin + route, { ...request, headers: { "content-type": "application/json" } })).status, 401);
    assert.equal((await fetch(origin + route, { ...request,
      headers: { "content-type": "application/json", cookie: `wand_session_local=${fileSession}` } })).status, 403);
  }
  const authorized = { authorization: `Bearer ${createHmac("sha256", appSecret).update(password).digest("hex")}` };
  const result = await fetch(origin + "/api/scheduled-tasks", { headers: authorized });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { tasks: [] });
  assert.equal((await fetch(origin + "/api/scheduled-tasks/missing", { headers: authorized })).status, 404);
  const calendar = await fetch(origin + "/api/scheduled-tasks/calendar?from=2030-01-01&to=2030-01-31&timeZone=UTC", { headers: authorized });
  assert.equal(calendar.status, 200); const body = await calendar.json();
  assert.deepEqual(body.tasks, []); assert.deepEqual(body.entries, []); assert.equal(body.range.complete, true);
});
