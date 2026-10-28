import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DEFAULT_EMPLOYEE_PROMPT } from "../src/default-employee.js";
import { DEFAULT_EMPLOYEE_ID } from "../src/employee-types.js";
import { knowledgeContext } from "../src/employee-knowledge.js";
import { WandStorage } from "../src/storage.js";
import type { KnowledgeDocument } from "../src/knowledge-types.js";
import type { SessionSnapshot } from "../src/types.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wand-knowledge-boundary-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const employee = storage.ensureDefaultSiliconEmployee();
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const legacy: SessionSnapshot = { id: "legacy", provider: "pi", command: "pi", cwd: root,
    sessionKind: "pty", mode: "default", status: "running", exitCode: null, startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null, output: "", archived: false, archivedAt: null, systemPrompt: DEFAULT_EMPLOYEE_PROMPT };
  return { root, storage, employee, legacy };
}

test("legacy role display projection grants no private knowledge until the stable employee binding is persisted", t => {
  const { storage, legacy } = fixture(t);
  storage.saveSession(legacy);
  assert.equal(storage.getSessionSlim(legacy.id)?.employeeId, DEFAULT_EMPLOYEE_ID, "legacy display remains intact");
  assert.equal(storage.knowledgeSessionScope(legacy.id), null);
  assert.throws(() => storage.issueKnowledgeAccess(legacy.id), /未绑定/);
  storage.saveSession({ ...legacy, employeeId: DEFAULT_EMPLOYEE_ID });
  const token = storage.issueKnowledgeAccess(legacy.id);
  assert.equal(storage.resolveKnowledgeAccess(token)?.employeeId, DEFAULT_EMPLOYEE_ID);
  storage.saveSession(legacy);
  assert.equal(storage.resolveKnowledgeAccess(token), null, "removing the explicit binding cannot be repaired by the display projection");
});

test("project-only authority survives a missing personal binding and malformed legacy options fail closed", t => {
  const { storage, root, legacy } = fixture(t);
  storage.saveSession(legacy);
  const project = storage.createWorkspace({ name: "明确项目", cwd: root });
  storage.setSessionWorkspaceId(legacy.id, project.id);
  assert.deepEqual(storage.knowledgeSessionScope(legacy.id), { sessionId: legacy.id, employeeId: null, workspaceId: project.id });
  const token = storage.issueKnowledgeAccess(legacy.id);
  assert.throws(() => storage.readKnowledgeLibrary("personal", DEFAULT_EMPLOYEE_ID, "", token), /失效/);
  assert.equal(storage.readKnowledgeLibrary("project", project.id, "", token).total, 0);
  const db = new DatabaseSync(storage.databasePath());
  try { db.prepare("UPDATE command_sessions SET session_options = ? WHERE id = ?").run("not-json", legacy.id); }
  finally { db.close(); }
  assert.equal(storage.knowledgeSessionScope(legacy.id)?.employeeId, null);
});

test("runtime context budgets both directory and complete JSON-encoded bodies, exposing omission counts for lookup", t => {
  const { storage, root, employee, legacy } = fixture(t);
  const project = storage.createWorkspace({ name: "文档项目", cwd: root });
  storage.saveSession({ ...legacy, employeeId: employee.id }); storage.setSessionWorkspaceId(legacy.id, project.id);
  for (const [scope, ownerId] of [["personal", employee.id], ["project", project.id]] as const) {
    for (let i = 0; i < 200; i++) storage.createKnowledgeDocument(scope, ownerId,
      { title: `文档 ${i} ${'标题'.repeat(40)}`, folder: '目录'.repeat(40), content: `知识 ${i}\n${'"\\'.repeat(250)}` });
  }
  const context = knowledgeContext(storage, storage.knowledgeSessionScope(legacy.id)!);
  const snapshots = JSON.parse(context.split("\n\n")[1]!) as Array<{
    scope: "personal" | "project"; ownerId: string; total: number;
    index: Array<{ id: string; title: string; folder: string; revision: number }>;
    records: Array<Pick<KnowledgeDocument, "id" | "revision" | "title" | "content">>;
    omittedIndexCount: number; omittedBodyCount: number;
  }>;
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.total, 200);
    assert.ok(snapshot.omittedIndexCount > 0); assert.ok(snapshot.omittedBodyCount > 0);
    assert.equal(snapshot.index.length + snapshot.omittedIndexCount, snapshot.total);
    assert.equal(snapshot.records.length + snapshot.omittedBodyCount, snapshot.total);
    assert.ok(JSON.stringify(snapshot.index).length <= 4002);
    assert.ok(JSON.stringify(snapshot.records).length <= 6002);
    for (const record of snapshot.records) assert.equal(record.content,
      storage.getKnowledgeDocument(snapshot.scope, snapshot.ownerId, record.id).content, "never truncate a fact");
    assert.equal(storage.readKnowledgeLibrary(snapshot.scope, snapshot.ownerId).entries.length, 200, "tools retain the complete bounded library");
  }
  assert.ok(context.length < 25_000, `actual context chars: ${context.length}`);
});

test("moving away and back cannot revive an execution capability, including legacy employee tokens", t => {
  const { storage, root, employee, legacy } = fixture(t);
  const first = storage.createWorkspace({ name: "项目甲", cwd: root });
  const second = storage.createWorkspace({ name: "项目乙", cwd: root + "/second" });
  storage.saveSession({ ...legacy, employeeId: employee.id });
  storage.setSessionWorkspaceId(legacy.id, first.id);
  const projectToken = storage.issueKnowledgeAccess(legacy.id);
  const legacyToken = storage.issueEmployeeKnowledgeAccess(legacy.id, employee.id);
  storage.setSessionWorkspaceId(legacy.id, second.id);
  storage.setSessionWorkspaceId(legacy.id, first.id);
  assert.equal(storage.resolveKnowledgeAccess(projectToken), null);
  assert.equal(storage.resolveEmployeeKnowledgeAccess(legacyToken), null);
  const other = { ...employee, id: "custom-employee", systemKey: undefined, tags: [], avatar: "", name: "另一个员工" };
  storage.saveSiliconEmployee(other);
  const employeeToken = storage.issueKnowledgeAccess(legacy.id);
  storage.saveSession({ ...legacy, employeeId: other.id, workspaceId: first.id });
  storage.saveSession({ ...legacy, employeeId: employee.id, workspaceId: first.id });
  assert.equal(storage.resolveKnowledgeAccess(employeeToken), null);
  const externalToken = storage.issueKnowledgeAccess(legacy.id);
  storage.saveSession({ ...legacy, employeeId: employee.id, workspaceId: first.id, automationId: "dingtalk:fixture" });
  storage.saveSession({ ...legacy, employeeId: employee.id, workspaceId: first.id });
  assert.equal(storage.resolveKnowledgeAccess(externalToken), null);
});

test("deleting and re-creating the same employee ID cannot revive its old execution", t => {
  const { storage, employee, legacy } = fixture(t);
  const custom = { ...employee, id: "recreated", systemKey: undefined, tags: [], avatar: "", name: "自定义员工" };
  storage.saveSiliconEmployee(custom);
  storage.saveSession({ ...legacy, employeeId: custom.id });
  const token = storage.issueKnowledgeAccess(legacy.id);
  storage.deleteSiliconEmployee(custom.id);
  storage.saveSiliconEmployee(custom);
  assert.equal(storage.resolveKnowledgeAccess(token), null);
});

test("unrelated session metadata saves preserve live knowledge capabilities", t => {
  const { storage, employee, legacy } = fixture(t);
  storage.saveSession({ ...legacy, employeeId: employee.id });
  const token = storage.issueKnowledgeAccess(legacy.id);
  storage.saveSession({ ...legacy, employeeId: employee.id, output: "new output", selectedModel: "another-model", systemPrompt: "updated-role" });
  assert.ok(storage.resolveKnowledgeAccess(token));
});

test("quota and duplicate-body validation do not masquerade as revision conflicts", t => {
  const { storage, employee } = fixture(t);
  const first = storage.createKnowledgeDocument("personal", employee.id, { content: "第一篇" }).entry;
  storage.createKnowledgeDocument("personal", employee.id, { content: "第二篇" });
  assert.throws(() => storage.updateKnowledgeDocument("personal", employee.id, first.id, first.revision, { content: "第二篇" }),
    error => error instanceof Error && (error as { status?: number }).status === 400);
  for (let i = 2; i < 200; i++) storage.createKnowledgeDocument("personal", employee.id, { content: `知识 ${i}` });
  assert.throws(() => storage.createKnowledgeDocument("personal", employee.id, { content: "超出上限" }),
    error => error instanceof Error && (error as { status?: number }).status === 400);
  assert.equal(storage.createKnowledgeDocument("personal", employee.id, { content: "第一篇" }).created, false);
});
