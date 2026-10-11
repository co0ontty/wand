import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WandStorage } from "../src/storage.js";
import { FIXED_EMPLOYEE_AVATARS, fixedEmployeeAvatar } from "../src/fixed-employee-avatar.js";
import { parseSiliconEmployeeInput, registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { DEFAULT_EMPLOYEE_PROMPT } from "../src/default-employee.js";
import { requireTeamEmployee } from "../src/ai-team-employee-binding.js";

const AGENT = { provider: "pi", engine: "sdk", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const NOW = "2026-10-10T00:00:00.000Z";
function fixture(t: { after(fn: () => void): void }, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "wand-fixed-cats-test-"));
  const path = join(root, "wand.db");
  let storage = new WandStorage(path);
  storage.ensureDefaultSiliconEmployee(); storage.ensureSystemSiliconEmployee();
  for (const target of FIXED_EMPLOYEE_AVATARS) {
    const existing = storage.getSiliconEmployeeDefinition(target.id)!;
    storage.saveSiliconEmployee({ ...existing, name: `custom-${target.id}`, duty: "custom duty", prompt: "custom prompt", agents: [AGENT], updatedAt: NOW });
  }
  for (const [id, avatar] of [["source-silver", "cat:1"], ["source-orange", "cat:0"]]) {
    storage.saveSiliconEmployee({ id: id!, name: "fixture source", duty: "source duty", prompt: "source prompt", avatar: avatar!, agents: [AGENT], tags: ["source"], createdAt: NOW, updatedAt: NOW });
  }
  if (legacy) {
    storage.close();
    const db = new DatabaseSync(path);
    for (const target of FIXED_EMPLOYEE_AVATARS) db.prepare("UPDATE silicon_employees SET avatar = ? WHERE id = ?").run(`legacy-${target.id}`, target.id);
    db.close(); storage = new WandStorage(path);
  }
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const expected = FIXED_EMPLOYEE_AVATARS.map((target) => ({ id: target.id, systemKey: target.systemKey, avatar: storage.getSiliconEmployeeDefinition(target.id)!.avatar }));
  return { storage, path, expected };
}

test("fixed avatar contract uses both stable identity fields, never name or source", () => {
  assert.equal(fixedEmployeeAvatar({ id: "e_wand_default", systemKey: "wand-default" }), "plush-cat:v1:silver");
  assert.equal(fixedEmployeeAvatar({ id: "e_wand_ops", systemKey: "wand-ops" }), "plush-cat:v1:orange");
  for (const identity of [{ id: "e_wand_default" }, { systemKey: "wand-default" }, { id: "other", systemKey: "wand-default" }, { id: "e_wand_ops", systemKey: "wand-default" }]) assert.equal(fixedEmployeeAvatar(identity), null);
});

test("seeds use fixed cats; restart and reads preserve all saved custom fields and legacy avatars", (t) => {
  const { storage } = fixture(t, true);
  const before = FIXED_EMPLOYEE_AVATARS.map((target) => storage.getSiliconEmployeeDefinition(target.id));
  for (let index = 0; index < 3; index++) { storage.ensureDefaultSiliconEmployee("codex"); storage.ensureSystemSiliconEmployee({ provider: "codex" }); storage.listSiliconEmployees(); }
  assert.deepEqual(FIXED_EMPLOYEE_AVATARS.map((target) => storage.getSiliconEmployeeDefinition(target.id)), before);
});

test("storage rejects avatar, identity, tags, archive, deletion and impersonation bypasses", (t) => {
  const { storage } = fixture(t);
  for (const target of FIXED_EMPLOYEE_AVATARS) {
    const existing = storage.getSiliconEmployeeDefinition(target.id)!;
    for (const patch of [{ avatar: "" }, { avatar: "cat:1" }, { systemKey: undefined }, { systemKey: "other" }, { tags: [] }, { archivedAt: NOW }]) assert.throws(() => storage.saveSiliconEmployee({ ...existing, ...patch }));
    assert.throws(() => storage.saveSiliconEmployee({ ...existing, id: "impersonator" }), /身份/);
    assert.throws(() => storage.archiveSiliconEmployee(target.id));
    assert.throws(() => storage.unarchiveSiliconEmployee(target.id));
    assert.throws(() => storage.deleteSiliconEmployee(target.id));
    assert.deepEqual(storage.getSiliconEmployeeDefinition(target.id), existing);
    storage.saveSiliconEmployee({ ...existing, name: "allowed edit", duty: "allowed duty", prompt: "allowed prompt", agents: [{ ...AGENT, model: "configured" }] });
    assert.equal(storage.getSiliconEmployeeDefinition(target.id)?.prompt, "allowed prompt");
  }
});

test("explicit avatar migration changes only the two avatar columns, is atomic and idempotent", (t) => {
  const { storage, path, expected } = fixture(t, true);
  const raw = () => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT * FROM silicon_employees ORDER BY id").all().map((row) => ({ ...row })); } finally { db.close(); } };
  const rawBefore = raw();
  const before = storage.listSiliconEmployees({ includeArchived: true });
  assert.throws(() => storage.migrateFixedEmployeeAvatars([expected[0]!]), /两个/);
  assert.throws(() => storage.migrateFixedEmployeeAvatars([expected[0]!, { ...expected[1]!, avatar: "stale" }]), /已变化/);
  assert.deepEqual(storage.listSiliconEmployees({ includeArchived: true }), before);
  assert.equal(storage.migrateFixedEmployeeAvatars(expected), 2);
  assert.equal(storage.migrateFixedEmployeeAvatars(expected), 0);
  assert.deepEqual(raw(), rawBefore.map((row) => ({ ...row, avatar: fixedEmployeeAvatar({ id: String(row.id), systemKey: row.system_key as string | null }) ?? row.avatar })));
  for (const employee of before) assert.deepEqual(storage.getSiliconEmployeeDefinition(employee.id), {
    ...employee, avatar: fixedEmployeeAvatar(employee) ?? employee.avatar,
  });
});

test("explicit avatar migration rejects missing or mismatched identity without partial changes", (t) => {
  const { storage, path, expected } = fixture(t, true);
  const db = new DatabaseSync(path);
  db.prepare("UPDATE silicon_employees SET system_key = ? WHERE id = ?").run("fixture-conflict", "e_wand_ops"); db.close();
  const before = storage.getSiliconEmployeeDefinition("e_wand_default");
  assert.throws(() => storage.migrateFixedEmployeeAvatars(expected), /身份冲突/);
  assert.deepEqual(storage.getSiliconEmployeeDefinition("e_wand_default"), before);
});

test("memory projection and team snapshot preserve custom role without persisting generated habits", (t) => {
  const { storage } = fixture(t);
  const now = Date.now();
  const before = storage.getSiliconEmployeeDefinition("e_wand_default")!;
  storage.appendUserMemoryEvent("session.prompt", "please be concise", "fixture", 0, now);
  const event = storage.listUserMemoryEvents()[0]!;
  assert.equal(storage.applyUserMemoryProfile({ generatedAt: now, expiresAt: now + 10000, preferences: [{ category: "communication", text: "简洁", evidenceIds: [event.id] }] }, 0, event.id, now), true);
  const projected = storage.getSiliconEmployee("e_wand_default")!;
  assert.ok(projected.prompt.startsWith(before.prompt)); assert.match(projected.prompt, /简洁/);
  assert.deepEqual(storage.getSiliconEmployeeDefinition(before.id), before);
  assert.equal(requireTeamEmployee(storage, before.id).prompt, before.prompt);
  storage.clearUserMemory();
  assert.deepEqual(storage.getSiliconEmployeeDefinition(before.id), before);
});

test("HTTP supports profile/tool partial edits, blocks fixed fields and keeps GET/save echoes migration-free", async (t) => {
  const { storage, expected } = fixture(t, true);
  storage.ensureDecisionExpertEmployee(); storage.ensureSpeechPolisherEmployee();
  const app = express(); app.use(express.json()); registerSiliconEmployeeRoutes(app, { storage });
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const before = storage.listSiliconEmployees({ includeArchived: true });
  await call("GET", "/api/silicon-employees");
  for (const target of FIXED_EMPLOYEE_AVATARS) {
    const path = `/api/silicon-employees/${target.id}`;
    await call("GET", path);
    assert.equal(storage.getSiliconEmployeeDefinition(target.id)?.avatar, expected.find((entry) => entry.id === target.id)?.avatar);
    const edited = await call("PUT", path, { name: "edited", duty: "updated duty", prompt: "updated prompt", agents: [AGENT] });
    assert.equal(edited.status, 200); assert.equal(edited.body.avatar, expected.find((entry) => entry.id === target.id)?.avatar);
    assert.equal((await call("PUT", path, { name: "only name" })).status, 200);
    assert.equal(storage.getSiliconEmployeeDefinition(target.id)?.prompt, "updated prompt");
    for (const patch of [{ avatar: null }, { avatar: "" }, { avatar: target.avatar }, { systemKey: null }, { id: "other" }, { tags: [] }]) assert.equal((await call("PUT", path, patch)).status, 400, JSON.stringify(patch));
    assert.equal((await call("POST", path + "/archive")).status, 400); assert.equal((await call("DELETE", path)).status, 400);
  }
  for (const employee of before.filter((entry) => !fixedEmployeeAvatar(entry))) assert.deepEqual(storage.getSiliconEmployeeDefinition(employee.id), employee);
  for (const employee of [storage.ensureDecisionExpertEmployee(), storage.ensureSpeechPolisherEmployee()]) assert.equal((await call("PUT", `/api/silicon-employees/${employee.id}`, { name: "cannot unlock", agents: [AGENT] })).status, 400);
  // Rendered memory sent back unchanged must not become durable profile content.
  const now = Date.now(); storage.appendUserMemoryEvent("session.prompt", "concise", "http-memory", 0, now);
  const event = storage.listUserMemoryEvents()[0]!;
  storage.applyUserMemoryProfile({ generatedAt: now, expiresAt: now + 10000, preferences: [{ category: "communication", text: "简洁", evidenceIds: [event.id] }] }, 0, event.id, now);
  const displayed = await call("GET", "/api/silicon-employees/e_wand_default");
  assert.match(displayed.body.prompt, /简洁/);
  assert.equal((await call("PUT", "/api/silicon-employees/e_wand_default", displayed.body)).status, 200);
  assert.equal(storage.getSiliconEmployeeDefinition("e_wand_default")?.prompt, "updated prompt");
});


test("employee API input accepts exact cat contract and rejects unversioned or unknown coats", () => {
  const input = { name: "fixture", duty: "", prompt: "", agents: [AGENT] };
  for (const avatar of ["plush-cat:v1:silver", "plush-cat:v1:orange"]) assert.equal(parseSiliconEmployeeInput({ ...input, avatar }, null, NOW).avatar, avatar);
  for (const avatar of ["plush-cat:v2:silver", "plush-cat:v1:gray", "plush-cat:silver", "plush-cat:v1:orange:extra"]) assert.throws(() => parseSiliconEmployeeInput({ ...input, avatar }, null, NOW), /头像格式无效/);
});


test("legacy generated preference tails expire in projections without rewriting saved columns", (t) => {
  const { storage } = fixture(t);
  const definition = storage.getSiliconEmployeeDefinition("e_wand_default")!;
  const legacy = { ...definition, prompt: DEFAULT_EMPLOYEE_PROMPT + "\n\n近期使用偏好（仅作参考；本轮要求冲突时忽略）：\n- 沟通：expired generated habit" };
  storage.saveSiliconEmployee(legacy);
  assert.equal(storage.getSiliconEmployee("e_wand_default")?.prompt, DEFAULT_EMPLOYEE_PROMPT);
  assert.equal(requireTeamEmployee(storage, "e_wand_default").prompt, DEFAULT_EMPLOYEE_PROMPT);
  storage.clearUserMemory(); storage.ensureDefaultSiliconEmployee();
  assert.deepEqual(storage.getSiliconEmployeeDefinition("e_wand_default"), legacy);
  // Similar wording inside an authored role remains authored content.
  storage.saveSiliconEmployee({ ...legacy, prompt: "custom introduction\n" + legacy.prompt });
  assert.equal(storage.getSiliconEmployee("e_wand_default")?.prompt, "custom introduction\n" + legacy.prompt);
});
