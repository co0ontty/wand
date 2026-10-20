import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { decisionExpertDefinition } from "../src/decision-expert-employee.js";
import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY } from "../src/decision-expert-identity.js";
import { hrEmployeeDefinition } from "../src/hr-employee.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { employeeUpdateInput } from "../src/web-ui/react/agents/employee-repository.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";

const roles = [decisionExpertDefinition("now"), hrEmployeeDefinition("now")];
const configuredAgents: SiliconEmployee["agents"] = [
  { provider: "codex", model: "custom-backup", thinkingEffort: "off", mode: "full-access", kind: "structured" },
  { provider: "pi", engine: "sdk", model: "configured-model", thinkingEffort: "off", mode: "default", kind: "structured" },
];

for (const role of roles) {
  test(`${role.systemKey}: storage locks identity, profile, archive and deletion without locking execution choices`, t => {
    const root = mkdtempSync(join(tmpdir(), "wand-builtin-lock-"));
    const storage = new WandStorage(join(root, "wand.db"));
    t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
    storage.saveSiliconEmployee(role);
    const original = storage.getSiliconEmployeeDefinition(role.id)!;
    for (const patch of [
      { name: "changed" }, { duty: "changed" }, { prompt: "changed" }, { avatar: "cat:3" },
      { tags: ["changed"] }, { id: "ordinary-id" }, { systemKey: "ordinary-key" }, { systemKey: undefined },
      { archivedAt: "2026-10-10T00:00:00Z" }, { archivedAt: "" },
    ]) {
      assert.throws(() => storage.saveSiliconEmployee({ ...role, ...patch }), /内置/);
      assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id), original, "rejection must leave the record untouched");
    }
    for (const action of ["archiveSiliconEmployee", "unarchiveSiliconEmployee", "deleteSiliconEmployee"] as const) {
      assert.throws(() => storage[action](role.id), /内置/);
      assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id), original);
    }
    storage.saveSiliconEmployee({ ...role, agents: configuredAgents });
    assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id)!.agents, configuredAgents);
  });

  test(`${role.systemKey}: API rejects locked fields and lifecycle mutations, and Web submits candidates only`, async t => {
    const root = mkdtempSync(join(tmpdir(), "wand-builtin-routes-"));
    const storage = new WandStorage(join(root, "wand.db"));
    storage.saveSiliconEmployee(role);
    const changed: string[] = [];
    const app = express(); app.use(express.json());
    registerSiliconEmployeeRoutes(app, { storage, notifyEmployeeChanged: id => changed.push(id) });
    app.use(jsonErrorHandler);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      storage.close(); rmSync(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/silicon-employees/${role.id}`;
    const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const original = storage.getSiliconEmployeeDefinition(role.id)!;
    for (const patch of [
      { name: "changed" }, { duty: "changed" }, { prompt: "changed" }, { avatar: "cat:3" },
      { tags: ["changed"] }, { id: "ordinary-id" }, { systemKey: "ordinary-key" },
      { name: null }, { duty: null }, { prompt: null }, { avatar: null },
    ]) {
      const response = await put({ agents: role.agents, ...patch });
      assert.equal(response.status, 400, JSON.stringify(patch));
      assert.match((await response.json()).error, /内置/);
      assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id), original);
    }
    for (const [method, suffix] of [["POST", "/archive"], ["POST", "/unarchive"], ["DELETE", ""]]) {
      assert.equal((await fetch(url + suffix, { method })).status, 400);
    }
    assert.deepEqual(changed, []);
    const input = employeeUpdateInput(role, { ...role, name: "ignored", prompt: "ignored", agents: configuredAgents });
    assert.deepEqual(input, { agents: configuredAgents });
    const response = await put(input);
    assert.equal(response.status, 200);
    const saved = await response.json();
    for (const field of ["name", "duty", "prompt", "avatar", "tags"] as const) assert.deepEqual(saved[field], role[field]);
    assert.deepEqual(saved.agents, configuredAgents);
    assert.deepEqual(changed, [role.id]);
  });
}

test("decision expert becomes 石一 by stable identity, preserving configured candidates and an unrelated same-name employee", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-builtin-rename-"));
  const dbPath = join(root, "wand.db"), storage = new WandStorage(dbPath);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const role = storage.ensureDecisionExpertEmployee();
  storage.saveSiliconEmployee({ ...role, agents: configuredAgents });
  const ordinary: SiliconEmployee = { id: "user-shiyi", name: "石一", duty: "开发组长", prompt: "用户角色", avatar: "cat:0", tags: ["研发"], agents: configuredAgents, createdAt: "before", updatedAt: "before" };
  storage.saveSiliconEmployee(ordinary);
  const priorOrdinary = storage.getSiliconEmployeeDefinition(ordinary.id);
  // Simulate an old installation without invoking a model or mutating the user's database.
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE silicon_employees SET name = ?, prompt = ?, updated_at = ? WHERE id = ?").run("决策专家", "旧版系统设定", "before", role.id);
  db.close();
  const renamed = storage.ensureDecisionExpertEmployee();
  assert.equal(renamed.id, DECISION_EXPERT_ID); assert.equal(renamed.systemKey, DECISION_EXPERT_KEY);
  assert.equal(renamed.name, "石一"); assert.match(renamed.prompt, /「石一」/);
  assert.deepEqual(renamed.agents, configuredAgents); assert.equal(renamed.createdAt, role.createdAt);
  const storedRenamed = storage.getSiliconEmployeeDefinition(role.id);
  storage.ensureDecisionExpertEmployee();
  assert.deepEqual(storage.getSiliconEmployeeDefinition(role.id), storedRenamed, "repeat seed is idempotent");
  assert.deepEqual(storage.getSiliconEmployeeDefinition(ordinary.id), priorOrdinary);
  storage.saveSiliconEmployee({ ...ordinary, name: "普通员工仍可编辑" });
  storage.archiveSiliconEmployee(ordinary.id); storage.unarchiveSiliconEmployee(ordinary.id);
  assert.equal(storage.getSiliconEmployeeDefinition(ordinary.id)?.name, "普通员工仍可编辑");
});

test("removed speech polisher row is archived, never deleted, and no longer seeded", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-retired-polisher-"));
  const dbPath = join(root, "wand.db");
  const storage = new WandStorage(dbPath);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO silicon_employees (id, name, duty, prompt, avatar, agents_json, system_key, archived_at, created_at, updated_at, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
    .run("e_wand_speech_polisher", "口述整理师", "", "旧设定", "", JSON.stringify(configuredAgents), "wand-speech-polisher", "before", "before", JSON.stringify(["系统用户"]));
  db.close();
  storage.retireLegacySpeechPolisherEmployee();
  const retired = storage.getSiliconEmployeeDefinition("e_wand_speech_polisher");
  assert.equal(retired?.prompt, "旧设定");
  assert.ok(retired?.archivedAt);
  assert.equal(storage.listSiliconEmployees().some(employee => employee.id === "e_wand_speech_polisher"), false);
  storage.retireLegacySpeechPolisherEmployee();
  assert.equal(storage.getSiliconEmployeeDefinition("e_wand_speech_polisher")?.archivedAt, retired?.archivedAt);
});
