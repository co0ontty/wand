import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WandStorage } from "../src/storage.js";
import { systemAiSessions } from "../src/system-ai-session-recorder.js";
import { SessionLogger } from "../src/session-logger.js";
import { parseSystemSessionLimit, registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { isRetainableSystemAiCall, isSystemAiCall, SYSTEM_AI_AUXILIARY_PURPOSES } from "../src/system-ai-call.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-system-retention-"));
  const db = path.join(root, "wand.db");
  const storage = new WandStorage(db);
  const employee = storage.ensureSystemSiliconEmployee();
  const recorder = systemAiSessions(storage);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const start = (actor = employee) => recorder.forEmployee(actor).start("session-title", { system: "fixture", prompt: "fixture" }, root);
  return { root, db, storage, employee, recorder, start };
}

test("limit parser rejects coercion, invalid numbers and accepts explicit unlimited/zero", () => {
  for (const value of [-1, 1.5, NaN, Infinity, 10001, "5", true, {}, []]) assert.throws(() => parseSystemSessionLimit(value));
  assert.equal(parseSystemSessionLimit(null), null);
  assert.equal(parseSystemSessionLimit(0), 0);
  assert.equal(parseSystemSessionLimit(10000), 10000);
  assert.equal(parseSystemSessionLimit(undefined, { systemSessionLimit: 3 } as never), 3);
});

test("default is unlimited; completed cap protects running/manual/other-employee and deletes links", t => {
  const f = fixture(t), first = f.start(), second = f.start();
  first.complete(); second.fail(new Error("fixture"));
  assert.ok(f.storage.getSessionSlim(first.sessionId));
  const running = f.start();
  const manual = { ...f.storage.getSession(first.sessionId)!, id: "manual", automationId: undefined, sessionSource: "interactive" as const };
  f.storage.saveSession(manual);
  const other = f.storage.ensureDecisionExpertEmployee(), otherCall = f.start(other); otherCall.complete();
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 1 });
  f.recorder.enforceRetention(f.employee.id);
  assert.equal(f.storage.getSessionSlim(first.sessionId), null);
  assert.equal(f.storage.employeeConversationForSession(first.sessionId), null);
  assert.ok(f.storage.getSessionSlim(second.sessionId));
  assert.ok(f.storage.getSessionSlim(running.sessionId));
  assert.ok(f.storage.getSessionSlim(otherCall.sessionId));
  assert.ok(f.storage.getSessionSlim("manual"));
  running.fail(new Error("fixture"), true);
  assert.equal(f.storage.getSessionSlim(second.sessionId), null);
  assert.ok(f.storage.getSessionSlim(running.sessionId));
  assert.equal(f.storage.conversationEvents(`dm_${f.employee.id}`).length, 1);
  first.candidateStarted({ provider: "pi" }); first.complete(); f.recorder.appendOutcome(first.sessionId, "late", "fixture");
  assert.equal(f.storage.getSessionSlim(first.sessionId), null, "late callbacks cannot resurrect deletion");
});

test("auxiliary history classification is explicit and protects agent decisions and unknown purposes", () => {
  for (const purpose of SYSTEM_AI_AUXILIARY_PURPOSES) {
    assert.equal(isRetainableSystemAiCall({ automationId: `system-ai:${purpose}:fixture` }), true);
  }
  for (const automationId of ["system-ai:decision:fixture", "system-ai:system-text:fixture", "system-ai:future-purpose:fixture",
    "system-ai:session-title:", "system-ai:session-title", "system-ai:session-title-agent:fixture",
    "ai-team:fixture", "wand-task:fixture", "wand-task-comment:fixture", "scheduled-task:fixture", undefined]) {
    assert.equal(isRetainableSystemAiCall({ automationId }), false, String(automationId));
  }
  assert.equal(isSystemAiCall({ automationId: "system-ai:decision:fixture" }), true, "audit/read-only identity is unchanged");
});

test("five counts only completed auxiliary calls; dispatch, agents, unknown and running records never enter the cap", t => {
  const f = fixture(t), logger = new SessionLogger(f.root);
  t.after(() => logger.dispose());
  f.recorder.attach({ logger });
  const titles: string[] = [], decisions: string[] = [];
  for (let i = 0; i < 9; i++) {
    const title = f.start(); title.complete(); titles.push(title.sessionId);
    const decision = f.recorder.forEmployee(f.employee).start("decision", { system: "fixture", prompt: "agent call" }, f.root);
    decision.complete(); decisions.push(decision.sessionId);
  }
  const template = f.storage.getSession(titles[0]!)!;
  const protectedIds: string[] = [...decisions];
  for (const [index, automationId] of ["wand-task:fixture", "wand-task-comment:fixture", "ai-team:fixture", "ai-team-chat:fixture",
    "system-ai:future-purpose:fixture", "system-ai:system-text:fixture", "system-ai:session-title:", undefined].entries()) {
    const id = `protected-${index}`;
    f.storage.saveSession({ ...template, id, automationId, startedAt: "2099-01-01T00:00:00.000Z" });
    protectedIds.push(id);
  }
  const running = f.start(); protectedIds.push(running.sessionId);
  const other = f.start(f.storage.ensureDecisionExpertEmployee()); other.complete(); protectedIds.push(other.sessionId);
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 5 });
  assert.deepEqual(f.storage.excessSystemAiSessionIds(f.employee.id, 5).sort(), titles.slice(0, 4).sort());
  f.recorder.enforceRetention(f.employee.id);
  for (const id of titles.slice(0, 4)) assert.equal(f.storage.getSessionSlim(id), null);
  for (const id of [...titles.slice(4), ...protectedIds]) assert.ok(f.storage.getSessionSlim(id), id);
  for (const id of decisions) {
    assert.equal(existsSync(path.join(f.root, "sessions", id)), true, "agent decision logs remain");
    assert.ok(f.storage.employeeConversationForSession(id), "agent decision canonical links remain");
  }
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 0 });
  f.recorder.enforceRetention(f.employee.id);
  for (const id of titles) assert.equal(f.storage.getSessionSlim(id), null);
  for (const id of protectedIds) assert.ok(f.storage.getSessionSlim(id), id);
});

test("zero removes all ended statuses and log files, never an active call", t => {
  const f = fixture(t);
  const logger = new SessionLogger(f.root);
  t.after(() => logger.dispose());
  f.recorder.attach({ logger });
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 0 });
  const a = f.start(), b = f.start(), c = f.start();
  a.complete(); b.fail(new Error("fixture")); c.fail(new Error("fixture"), true);
  for (const call of [a, b, c]) {
    assert.equal(f.storage.getSessionSlim(call.sessionId), null);
    assert.equal(f.storage.employeeConversationForSession(call.sessionId), null);
    assert.equal(existsSync(path.join(f.root, "sessions", call.sessionId)), false);
  }
  const active = f.start();
  assert.throws(() => f.recorder.remove(active.sessionId), /仍在执行/);
  assert.ok(f.storage.getSessionSlim(active.sessionId));
});

test("cap uses creation order (not completion order) and deterministic ties; archived histories also count", t => {
  const f = fixture(t), old = f.start(), newer = f.start();
  const before = f.storage.getSession(old.sessionId)!;
  f.storage.saveSession({ ...before, startedAt: "2000-01-01T00:00:00.000Z" });
  // Finish callback owns its original snapshot: update after finish to model historical timestamps.
  newer.complete(); old.complete();
  f.storage.saveSession({ ...f.storage.getSession(old.sessionId)!, startedAt: "2000-01-01T00:00:00.000Z", archived: true });
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 1 });
  f.recorder.enforceRetention(f.employee.id);
  assert.equal(f.storage.getSessionSlim(old.sessionId), null);
  assert.ok(f.storage.getSessionSlim(newer.sessionId));
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: null });
  const tieA = f.start(), tieB = f.start(); tieA.complete(); tieB.complete();
  for (const call of [tieA, tieB]) f.storage.saveSession({ ...f.storage.getSession(call.sessionId)!, startedAt: "2030-01-01T00:00:00.000Z" });
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 1 });
  f.recorder.enforceRetention(f.employee.id);
  assert.equal(f.storage.getSessionSlim(tieA.sessionId), null);
  assert.ok(f.storage.getSessionSlim(tieB.sessionId), "same timestamp retains the later insertion deterministically");
});

test("persisted limit survives re-open and restart recovery cleans interrupted records after logger attach", t => {
  const f = fixture(t); const call = f.start();
  const decision = f.recorder.forEmployee(f.employee).start("decision", { system: "fixture", prompt: "agent call" }, f.root);
  f.storage.saveSiliconEmployee({ ...f.employee, systemSessionLimit: 0 });
  const second = new WandStorage(f.db);
  const recorder = systemAiSessions(second);
  try {
    assert.equal(second.getSystemSiliconEmployee()?.systemSessionLimit, 0);
    recorder.recoverInterrupted();
    assert.equal(second.getSessionSlim(call.sessionId)?.status, "failed");
    const logger = new SessionLogger(f.root);
    recorder.attach({ logger });
    assert.equal(second.getSessionSlim(call.sessionId), null);
    assert.equal(second.getSessionSlim(decision.sessionId)?.status, "failed", "restart preserves interrupted agent decisions");
    logger.dispose();
  } finally { second.close(); }
});

test("HTTP partial edits support all employee identities; invalid cap is atomic, omitted preserves, null disables", async t => {
  const f = fixture(t);
  const app = express(); app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage: f.storage });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/silicon-employees/`;
  const put = (id: string, body: unknown) => fetch(url + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const identities = [f.employee, f.storage.ensureDecisionExpertEmployee(), f.storage.ensureHrEmployee(), f.storage.ensureDefaultSiliconEmployee(),
    { ...f.employee, id: "ordinary", name: "普通员工", systemKey: undefined, avatar: "", tags: [] }];
  f.storage.saveSiliconEmployee(identities.at(-1)!);
  for (const employee of identities) {
    const call = f.start(employee); call.complete();
    let response = await put(employee.id, { systemSessionLimit: 0 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).systemSessionLimit, 0);
    assert.equal(f.storage.getSessionSlim(call.sessionId), null);
    response = await put(employee.id, { systemSessionLimit: -1 });
    assert.equal(response.status, 400);
    assert.equal(f.storage.getSiliconEmployee(employee.id)?.systemSessionLimit, 0);
    assert.equal((await put(employee.id, {})).status, 200);
    assert.equal(f.storage.getSiliconEmployee(employee.id)?.systemSessionLimit, 0);
    response = await put(employee.id, { systemSessionLimit: null });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).systemSessionLimit, null);
  }
});
