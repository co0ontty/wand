import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import express from "express";
import { KnowledgeError } from "../src/knowledge-types.js";
import { knowledgeContext, startEmployeeKnowledgeRunner } from "../src/employee-knowledge.js";
import { registerKnowledgeRoutes } from "../src/server-knowledge-routes.js";
import { requiredApiScope } from "../src/middleware/api-scope.js";
import { WandStorage } from "../src/storage.js";
import { STORAGE_MIGRATIONS } from "../src/storage/migrations.js";
import { installKnowledgeSkill } from "../src/knowledge-skill.js";
import { buildChildEnv } from "../src/env-utils.js";
import type { SessionSnapshot } from "../src/types.js";
import type { StructuredRunnerContext } from "../src/structured-runner.js";

const exec = promisify(execFile);
const session = (id: string, employeeId?: string): SessionSnapshot => ({ id, employeeId, command: "pi", provider: "pi",
  sessionKind: "structured", cwd: "/tmp", mode: "default", status: "idle", exitCode: null, startedAt: new Date().toISOString(),
  endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null });
function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-library-"));
  const storage = new WandStorage(join(root, "wand.db"));
  for (const id of ["e1", "e2"]) storage.saveSiliconEmployee({ id, name: id, duty: "", prompt: "", avatar: "", agents: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  const p1 = storage.createWorkspace({ name: "项目一", cwd: root });
  const p2 = storage.createWorkspace({ name: "项目二", cwd: root + "/second" });
  storage.saveSession(session("s", "e1")); storage.setSessionWorkspaceId("s", p1.id);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { storage, root, p1, p2 };
}
const status = (code: number) => (error: unknown) => error instanceof KnowledgeError && error.status === code;

test("additive v22 migration upgrades historical rows without changing identity, body or ownership", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-library-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "wand.db");
  const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL("./fixtures/storage/schema-v4.sql", import.meta.url), "utf8"));
  for (const migration of STORAGE_MIGRATIONS.filter(m => m.version > 4 && m.version < 22)) migration.up(db, { dataDir: root });
  db.exec("PRAGMA user_version = 21");
  db.prepare("INSERT INTO silicon_employees(id,name,agents_json,created_at,updated_at) VALUES ('old','旧员工','[]','2026-01-01','2026-01-01')").run();
  const content = "旧的完整正文\n第二行保持不变。";
  db.prepare("INSERT INTO employee_knowledge(id,employee_id,content,content_hash,created_at) VALUES ('k_old','old',?,?,'2026-01-01')")
    .run(content, createHash("sha256").update(content).digest("hex"));
  db.close();
  const storage = new WandStorage(dbPath);
  try {
    const entry = storage.readKnowledgeLibrary("personal", "old").entries[0]!;
    assert.equal(entry.id, "k_old"); assert.equal(entry.ownerId, "old"); assert.equal(entry.content, content);
    assert.equal(entry.title, "旧的完整正文"); assert.equal(entry.folder, "未分类"); assert.equal(entry.revision, 1);
    assert.equal(storage.rememberEmployeeKnowledge("old", content).id, "k_old");
  } finally { storage.close(); }
});

test("documents share legacy personal data, isolate scopes, enforce revisions and retain removed-project knowledge", t => {
  const { storage, p1, p2 } = setup(t);
  const old = storage.rememberEmployeeKnowledge("e1", "已有个人知识");
  assert.equal(storage.readKnowledgeLibrary("personal", "e1").entries[0]?.id, old.id);
  assert.equal(storage.readKnowledgeLibrary("personal", "e2").total, 0);
  const entry = storage.createKnowledgeDocument("project", p1.id, { title: "发布", content: "每周五发布", folder: "规范" }).entry;
  assert.equal(storage.createKnowledgeDocument("project", p1.id, { content: entry.content }).created, false);
  assert.equal(storage.readKnowledgeLibrary("project", p2.id).total, 0);
  assert.throws(() => storage.getKnowledgeDocument("personal", "e1", entry.id), status(404));
  const saved = storage.updateKnowledgeDocument("project", p1.id, entry.id, 1, { title: "发布窗口", content: "改为周六", folder: "规范" });
  assert.equal(saved.revision, 2);
  assert.throws(() => storage.updateKnowledgeDocument("project", p1.id, entry.id, 1, { content: "迟到覆盖" }), status(409));
  assert.throws(() => storage.deleteKnowledgeDocument("project", p1.id, entry.id, 1), status(409));
  storage.deleteWorkspace(p1.id);
  assert.equal(storage.readKnowledgeLibrary("project", p1.id).readOnly, true);
  assert.ok(storage.knowledgeOwners().projects.some(p => p.id === p1.id && p.readOnly));
  assert.throws(() => storage.createKnowledgeDocument("project", p1.id, { content: "不得写入孤立库" }), status(409));
  storage.deleteKnowledgeDocument("project", p1.id, entry.id, 2);
  assert.ok(!storage.knowledgeOwners().projects.some(p => p.id === p1.id));
});

test("runtime capabilities bind both stable owners and invalidate on correction/deletion/clear/move", t => {
  const { storage, p1, p2 } = setup(t);
  const token = storage.issueKnowledgeAccess("s");
  assert.deepEqual(storage.resolveKnowledgeAccess(token), { sessionId: "s", employeeId: "e1", workspaceId: p1.id });
  assert.throws(() => storage.readKnowledgeLibrary("personal", "e2", "", token), status(403));
  assert.throws(() => storage.createKnowledgeDocument("project", p2.id, { content: "跨项目" }, token), status(403));
  const entry = storage.createKnowledgeDocument("personal", "e1", { content: "待修正" }, token).entry;
  storage.updateKnowledgeDocument("personal", "e1", entry.id, 1, { content: "已修正" });
  assert.equal(storage.resolveKnowledgeAccess(token), null);
  assert.throws(() => storage.createKnowledgeDocument("personal", "e1", { content: "待修正" }, token), status(403));
  const deleted = storage.issueKnowledgeAccess("s");
  storage.forgetEmployeeKnowledge("e1", entry.id);
  assert.equal(storage.resolveKnowledgeAccess(deleted), null);
  const cleared = storage.issueKnowledgeAccess("s"); storage.clearEmployeeKnowledge("e1");
  assert.equal(storage.resolveKnowledgeAccess(cleared), null);
  const moved = storage.issueKnowledgeAccess("s"); storage.setSessionWorkspaceId("s", p2.id);
  assert.equal(storage.resolveKnowledgeAccess(moved), null);
  const changed = storage.issueKnowledgeAccess("s"); storage.saveSession({ ...storage.getSession("s")!, employeeId: "e2" });
  assert.equal(storage.resolveKnowledgeAccess(changed), null);
  storage.saveSession({ ...storage.getSession("s")!, automationId: "dingtalk:fixture" });
  assert.equal(storage.knowledgeSessionScope("s"), null);
});

test("runtime does not autosave user prefixes; context contains complete bounded bodies and no other private data", async t => {
  const { storage, p1 } = setup(t);
  storage.createKnowledgeDocument("personal", "e2", { content: "FOREIGN_PRIVATE" });
  storage.createKnowledgeDocument("project", p1.id, { title: "长文", content: "LONG_" + "字".repeat(11000) });
  storage.createKnowledgeDocument("personal", "e1", { title: "小文", content: "完整事实" });
  const snapshot = knowledgeContext(storage, storage.knowledgeSessionScope("s")!);
  assert.ok(snapshot.includes("长文")); assert.ok(!snapshot.includes("LONG_"));
  assert.ok(snapshot.includes("完整事实")); assert.ok(!snapshot.includes("FOREIGN_PRIVATE"));
  let receive!: StructuredRunnerContext;
  let finish!: () => void;
  const run = startEmployeeKnowledgeRunner(storage, { start(ctx) {
    receive = ctx; return { completion: new Promise<void>(done => { finish = done; }), interrupt() {} };
  } }, { session: storage.getSession("s")!, prompt: "记住：不要把这句话自动保存", env: {} }, { isActive: () => true, onUpdate() {} });
  assert.equal(storage.readKnowledgeLibrary("personal", "e1").total, 1);
  assert.equal(storage.readKnowledgeLibrary("project", p1.id).total, 1);
  assert.ok(storage.resolveKnowledgeAccess(receive.env.WAND_KNOWLEDGE_TOKEN!));
  run.interrupt(); assert.equal(storage.resolveKnowledgeAccess(receive.env.WAND_KNOWLEDGE_TOKEN!), null);
  finish(); await run.completion;
});

test("HTTP validates scope and revision, serves complete libraries, and never exposes access capabilities", async t => {
  const { storage, p1 } = setup(t);
  const app = express(); app.use(express.json()); registerKnowledgeRoutes(app, storage);
  const server = createServer(app); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/knowledge`;
  const send = (method: string, suffix: string, value: unknown) => fetch(url + suffix, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const input = { scope: "project", ownerId: p1.id, content: "项目文档", title: "标题", folder: "工作" };
  const response = await send("POST", "", input); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { entry } = await response.json() as { entry: { id: string; revision: number } };
  assert.equal((await send("PATCH", `/${entry.id}`, { ...input, revision: 0 })).status, 400);
  assert.equal((await send("PATCH", `/${entry.id}`, { ...input, revision: 1, content: "正文二" })).status, 200);
  assert.equal((await send("DELETE", `/${entry.id}`, { ...input, revision: 1 })).status, 409);
  assert.equal((await send("POST", "", { ...input, scope: "admin" })).status, 400);
  assert.equal((await send("POST", "", { ...input, content: "password=fixture-only" })).status, 400);
  for (let i = 0; i < 24; i++) storage.createKnowledgeDocument("personal", "e1", { content: `资料 ${i}` });
  const list = await (await fetch(url + "?scope=personal&ownerId=e1")).json() as { entries: unknown[] };
  assert.equal(list.entries.length, 24);
  assert.ok(!JSON.stringify(await (await fetch(url + "/owners")).json()).includes("token"));
  assert.equal(requiredApiScope("/api/knowledge"), "sessions");
  assert.equal(requiredApiScope("/api/knowledge/owners"), "sessions");
});

test("real CLI and installed skill write the intended scope; stdin rechecks access after a clear", async t => {
  const { storage, root, p1 } = setup(t);
  const token = storage.issueKnowledgeAccess("s");
  const env = { ...process.env, WAND_KNOWLEDGE_DB: storage.databasePath(), WAND_KNOWLEDGE_TOKEN: token };
  const invoke = async (command: string, ...args: string[]) => JSON.parse((await exec(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), `knowledge:${command}`, ...args], { env, timeout: 15_000 })).stdout);
  const saved = await invoke("remember", "共享规范", "--scope", "project", "--title", "测试规范", "--folder", "规范");
  assert.equal(saved.entry.ownerId, p1.id); assert.equal(storage.countEmployeeKnowledge("e1"), 0);
  assert.equal((await invoke("read", saved.entry.id, "--scope", "project")).entry.content, "共享规范");
  await assert.rejects(invoke("read", saved.entry.id));
  await assert.rejects(invoke("remember", "错误归属", "--ownerId", "e2"));
  await installKnowledgeSkill(join(root, "config.json"), ["pi"], join(root, "home"));
  const wrapper = join(root, "skills/wand-knowledge/scripts/knowledge.mjs");
  const update = JSON.parse((await exec(process.execPath, [wrapper, "update", saved.entry.id, "修改后规范", "--scope", "project", "--revision", "1"], { env, timeout: 15_000 })).stdout);
  assert.equal(update.entry.revision, 2); assert.equal(update.entry.title, "测试规范");
  const freshToken = storage.issueKnowledgeAccess("s");
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "knowledge:remember", "--stdin"], { env: { ...env, WAND_KNOWLEDGE_TOKEN: freshToken } });
  let stderr = ""; child.stderr.on("data", b => { stderr += b; }); child.stdout.resume();
  storage.clearEmployeeKnowledge("e1"); child.stdin.end("不得迟到复活");
  assert.notEqual(await new Promise(resolve => child.once("exit", resolve)), 0);
  assert.match(stderr, /失效/); assert.equal(storage.countEmployeeKnowledge("e1"), 0);
});

test("unrelated child processes strip inherited knowledge credentials but explicitly authorized extras survive", t => {
  const previous = process.env.WAND_KNOWLEDGE_TOKEN;
  process.env.WAND_KNOWLEDGE_TOKEN = "parent-fixture";
  t.after(() => { if (previous === undefined) delete process.env.WAND_KNOWLEDGE_TOKEN; else process.env.WAND_KNOWLEDGE_TOKEN = previous; });
  assert.equal(buildChildEnv(true).WAND_KNOWLEDGE_TOKEN, undefined);
  assert.equal(buildChildEnv(true, { WAND_KNOWLEDGE_TOKEN: "own-fixture" }).WAND_KNOWLEDGE_TOKEN, "own-fixture");
});
