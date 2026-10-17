import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WandStorage } from "../src/storage.js";
import { ConversationOrganizationService, type ConversationOrganizationDependencies } from "../src/conversation-organize-service.js";
import { conversationContent, parseConversationGrouping, type ConversationGroupingInput } from "../src/conversation-organize.js";
import type { SessionSnapshot } from "../src/types.js";
import { systemAiSessions } from "../src/system-ai-session-recorder.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-content-organize-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  storage.ensureSystemSiliconEmployee({ provider: "pi" });
  const workspace = storage.createWorkspace({ name: "Project", cwd: root });
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const save = (id: string, content: string, patch: Partial<SessionSnapshot> = {}) => {
    const session: SessionSnapshot = { id, provider: "pi", sessionKind: "structured", command: "pi", cwd: root, workspaceId: workspace.id,
      mode: "default", status: "idle", exitCode: null, startedAt: "2026-10-01T00:00:00Z", endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null,
      title: "与工作无关的相同标题", messages: [{ role: "user", content: [{ type: "text", text: content }] }], ...patch };
    storage.saveSession(session);return session;
  };
  const scope = { target: { kind: "workspace" as const, workspaceId: workspace.id }, mode: "auto" as const };
  const service = (deps: ConversationOrganizationDependencies) => new ConversationOrganizationService(storage, deps);
  return { root, storage, workspace, save, scope, service };
}
async function done(service: ConversationOrganizationService, id: string) {
  for (let n = 0; n < 500; n++) { const job = service.get(id)!; if (job.status !== "running") return job; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw Error("test job never settled");
}
const newGroup = (input: ConversationGroupingInput, title = "通知设置保存问题") => ({ groups: [{ existingTaskId: null, title, description: "按真实正文整理工作", sessionIds: input.sessions.map(s => s.id) }], unassigned: [] });

test("with no existing task, actual messages drive new task creation and membership, not matching titles", async t => {
  const f = fixture(t);f.save("one", "保存按钮点击后没有发送请求");f.save("two", "通知设置保存请求没有触发，需要修复点击处理");
  let called = 0;
  const service = f.service({ judge: async input => { called++;assert.equal(input.tasks.length, 0);assert.match(input.sessions[0]!.content, /保存/);return newGroup(input); } });
  const preview = service.prepare(f.scope);assert.equal(preview.sessionCount, 2);assert.equal(preview.existingTaskCount, 0);
  assert.equal(f.storage.listWandTasks().length, 0, "preview cannot create tasks or execute a model");assert.equal(called, 0);
  const job = await done(service, service.start(preview.token).id);
  assert.equal(job.status, "completed");assert.equal(called, 1);assert.equal(job.result.createdTasks.length, 1);assert.equal(job.result.movedSessions.length, 2);
  const task = job.result.createdTasks[0]!;
  assert.equal(f.storage.getWandTask(task.cardId)?.titleSource, "auto");
  assert.equal(f.storage.getSession("one")?.workspaceTaskId, task.taskId);assert.equal(f.storage.getSession("two")?.workspaceTaskId, task.taskId);
  assert.equal(f.storage.getSession("one")?.cwd, f.root, "classification never changes execution cwd");
  assert.ok(job.logSessionId);assert.equal(f.storage.getSession(job.logSessionId!)?.employeeId, "e_wand_ops");
  const repeated = service.start(preview.token);assert.equal(repeated.id, job.id);assert.equal(called, 1, "same confirmation receipt never replays");
  const next = service.prepare(f.scope);assert.equal(next.unchanged, true);
  const unchanged = service.start(next.token);assert.equal(unchanged.status, "completed");assert.equal(unchanged.result.unchanged, true);assert.equal(called, 1);
});

test("same titles with different bodies can become separate meaningful tasks", async t => {
  const f = fixture(t);f.save("web", "修复通知设置保存提交");f.save("release", "打包发布 macOS 测试版本");
  const service = f.service({ judge: async input => {
    assert.equal(input.sessions[0]!.title, input.sessions[1]!.title);
    assert.notEqual(input.sessions[0]!.content, input.sessions[1]!.content);
    return { groups: input.sessions.map(s => ({ existingTaskId: null, title: s.id === "web" ? "修复通知设置保存" : "macOS测试版分发", description: s.content, sessionIds: [s.id] })), unassigned: [] };
  } });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.result.createdTasks.length, 2);assert.notEqual(f.storage.getSession("web")?.workspaceTaskId, f.storage.getSession("release")?.workspaceTaskId);
});

test("a suitable existing task is reused without deleting history or renaming a user task", async t => {
  const f = fixture(t);f.save("s", "修复通知保存提交");
  const target = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "用户固定标题" });
  const service = f.service({ judge: async input => ({ groups: [{ existingTaskId: input.tasks[0]!.id, title: "不会覆盖用户标题", description: "不会覆盖原描述", sessionIds: ["s"] }], unassigned: [] }) });
  const scope = { ...f.scope, mode: "all" as const };
  const job = await done(service, service.start(service.prepare(scope).token).id);
  assert.equal(job.result.createdTasks.length, 0);assert.equal(job.result.reusedTasks[0]?.taskId, target.id);
  assert.equal(f.storage.getWorkspaceTask(target.id)?.name, "用户固定标题");assert.equal(f.storage.getSession("s")?.workspaceTaskId, target.id);
});

test("default excludes manual-task conversations before reading their body; explicit all includes them", async t => {
  const f = fixture(t);
  const manual = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "我的手动任务" });
  f.save("protected", "private body", { workspaceTaskId: manual.id });f.save("loose", "另一个实际工作");
  const read: string[] = [];
  const service = f.service({ getSession: id => { read.push(id);return f.storage.getSession(id); }, judge: async input => newGroup(input) });
  const preview = service.prepare(f.scope);assert.equal(preview.sessionCount, 1);assert.equal(preview.manualSessionCount, 1);assert.equal(read.includes("protected"), false);
  const job = await done(service, service.start(preview.token).id);assert.equal(job.result.movedSessions.length, 1);assert.equal(f.storage.getSession("protected")?.workspaceTaskId, manual.id);
  const all = service.prepare({ ...f.scope, mode: "all" });assert.equal(all.sessionCount, 2);assert.equal(all.manualSessionCount, 0);assert.ok(read.includes("protected"));
});

test("persisted user provenance protects both user-created and user-renamed tasks before body reads, while explicit all includes both", async t => {
  const f = fixture(t);
  const created = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "用户创建的固定标题" });
  const renamed = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "系统自动初始名", board: { titleSource: "auto" } });
  f.storage.updateWorkspaceTask(renamed.id, { name: "用户后来指定的新标题" });
  assert.equal(f.storage.getWandTaskByWorkspaceTaskId(renamed.id)?.titleSource, "user");
  f.save("created", "工作正文", { workspaceTaskId: created.id });f.save("renamed", "工作正文", { workspaceTaskId: renamed.id });f.save("loose", "工作正文");
  const reads: string[] = [];
  const service = f.service({ getSession: id => { reads.push(id);return f.storage.getSession(id); }, judge: async input => newGroup(input) });
  const automatic = service.prepare(f.scope);assert.equal(automatic.sessionCount, 1);assert.equal(automatic.manualSessionCount, 2);assert.deepEqual(reads, ["loose"]);
  const all = service.prepare({ ...f.scope, mode: "all" });assert.equal(all.sessionCount, 3);assert.equal(all.manualSessionCount, 0);
  const job = await done(service, service.start(all.token).id);assert.equal(job.status, "completed");assert.equal(job.result.movedSessions.length, 3);
  assert.equal(f.storage.getWorkspaceTask(created.id)?.name, "用户创建的固定标题");assert.equal(f.storage.getWorkspaceTask(renamed.id)?.name, "用户后来指定的新标题");
});

test("directory boundaries are hard constraints even for equivalent conversation bodies", async t => {
  const f = fixture(t);f.save("a", "相同工作内容");
  const cwd = path.join(f.root, "other");mkdirSync(cwd);const b = f.storage.createWorkspace({ name: "Other", cwd });f.save("b", "相同工作内容", { cwd, workspaceId: b.id });
  const service = f.service({ judge: async input => { assert.equal(input.sessions.length, 1);return newGroup(input); } });
  const job = await done(service, service.start(service.prepare({ target: { kind: "all" }, mode: "auto" }).token).id);
  assert.equal(job.result.createdTasks.length, 2);assert.notEqual(f.storage.getSession("a")?.workspaceTaskId, f.storage.getSession("b")?.workspaceTaskId);
});

test("new input or user renaming while a model waits cannot be overwritten or create an empty orphan task", async t => {
  const f = fixture(t);const owner = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "系统名", board: { titleSource: "auto" } });
  f.save("s", "原始内容", { workspaceTaskId: owner.id });
  const service = f.service({ judge: async input => { f.storage.updateWorkspaceTask(owner.id, { name: "用户已指定新标题" });return newGroup(input); } });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.result.createdTasks.length, 0);assert.equal(job.result.movedSessions.length, 0);assert.equal(job.result.refused.length, 1);
  assert.equal(f.storage.getSession("s")?.workspaceTaskId, owner.id);assert.equal(f.storage.listWandTasks().length, 1);
});

test("queued user input invalidates a prepared snapshot but assistant progress does not", t => {
  const f = fixture(t);const original = f.save("s", "目标");
  const service = f.service({ judge: async input => newGroup(input) });const preview = service.prepare(f.scope);
  f.storage.saveSession({ ...original, queuedMessages: ["新的意图"] });assert.throws(() => service.start(preview.token), /已变化/);
  const current = f.storage.getSession("s")!, fresh = service.prepare(f.scope);
  f.storage.saveSession({ ...current, messages: [...current.messages!, { role: "assistant", content: [{ type: "text", text: "生成中的助手回复" }] }] });
  assert.doesNotThrow(() => service.start(fresh.token));
});

test("all long-message chunks are summarized; no source text is silently reduced to title-only", async t => {
  const f = fixture(t);f.save("long", "头部目标" + "中间工作内容".repeat(1900) + "尾部新方向");
  const pieces: string[] = [];
  const service = f.service({ summarize: async content => { pieces.push(content);return content.length > 1500 ? content.slice(0, 750) + content.slice(-750) : content; }, judge: async input => { assert.ok(input.sessions[0]!.content.length <= 1600);return newGroup(input); } });
  const preview = service.prepare(f.scope);assert.ok(preview.estimatedModelRequests > 1);
  const job = await done(service, service.start(preview.token).id);
  assert.equal(job.status, "completed");assert.ok(pieces.some(s => s.includes("头部目标")));assert.ok(pieces.some(s => s.includes("尾部新方向")));
});

test("partial cancellation preserves already committed batches and never starts a second writer", async t => {
  const f = fixture(t);for (let n = 0; n < 9; n++) f.save("s" + n, "同一工作正文");
  let calls = 0;
  const service = f.service({ judge: async (input, signal) => {
    calls++;if (calls === 1) return newGroup(input);
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  } });
  const accepted = service.start(service.prepare(f.scope).token);
  for (let n = 0; n < 500 && service.get(accepted.id)!.result.movedSessions.length < 8; n++) await new Promise(resolve => setTimeout(resolve, 2));
  service.cancel(accepted.id);const job = await done(service, accepted.id);
  assert.equal(job.status, "cancelled");assert.equal(job.result.createdTasks.length, 1);assert.equal(job.result.movedSessions.length, 8);
  assert.equal(f.storage.listWandTasks().length, 1);assert.equal(f.storage.getSession("s8")?.workspaceTaskId, undefined);
});

test("malformed model membership is rejected before any task/membership mutation", async t => {
  const f = fixture(t);f.save("s", "工作");
  const service = f.service({ judge: async () => ({ groups: [{ existingTaskId: null, title: "恶意分组", description: "", sessionIds: ["s", "unknown"] }], unassigned: [] }) });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.status, "failed");assert.equal(f.storage.listWandTasks().length, 0);assert.equal(f.storage.getSession("s")?.workspaceTaskId, undefined);
  const input: ConversationGroupingInput = { tasks: [], sessions: [{ id: "s", title: "", content: "body", currentTaskId: null }] };
  assert.throws(() => parseConversationGrouping('{"groups":[],"unassigned":[]}', input), /遗漏/);
});

test("same complete membership can update only an automatic title without duplicating a task or overwriting a description", async t => {
  const f = fixture(t);const original = f.storage.createWorkspaceTask({ workspaceId: f.workspace.id, name: "旧系统工作", board: { titleSource: "auto", description: "人工写入的验收标准必须保留" } });
  f.save("s", "整理新的发布流水线", { workspaceTaskId: original.id });
  const service = f.service({ judge: async input => newGroup(input, "发布流水线整理") });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.status, "completed");assert.equal(job.result.createdTasks.length, 0);assert.equal(job.result.updatedTasks.length, 1);
  assert.equal(f.storage.getWorkspaceTask(original.id)?.name, "发布流水线整理");
  assert.equal(f.storage.listWandTasks()[0]?.description, "人工写入的验收标准必须保留");assert.equal(f.storage.listWandTasks().length, 1);
  assert.equal(job.result.reusedTasks[0]?.taskId, original.id);
});

test("new automatic tasks preserve the actual SDK engine instead of silently defaulting to Pi CLI", async t => {
  const f = fixture(t);f.save("sdk", "工作目标", { structuredState: { engine: "core", model: "fixture-model" } as SessionSnapshot["structuredState"] });
  const service = f.service({ judge: async input => newGroup(input) });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.result.createdTasks.length, 1);assert.equal(f.storage.listWandTasks()[0]?.agent?.engine, "sdk");
});

test("later semantic batches can reuse tasks actually created by the earlier batch", async t => {
  const f = fixture(t);for (let n = 0; n < 9; n++) f.save("s" + n, "同一真实工作");
  let calls = 0;
  const service = f.service({ judge: async input => {
    calls++;if (calls === 1) return newGroup(input);
    assert.equal(input.tasks.length, 1);assert.equal(input.sessions.length, 1);
    return { groups: [{ existingTaskId: input.tasks[0]!.id, title: "", description: "", sessionIds: input.sessions.map(s => s.id) }], unassigned: [] };
  } });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.status, "completed");assert.equal(calls, 2);assert.equal(job.result.createdTasks.length, 1);assert.equal(job.result.movedSessions.length, 9);assert.equal(f.storage.listWandTasks().length, 1);
});

test("image-only new input during judgment refuses a stale movement without forwarding image bytes", async t => {
  const f = fixture(t);f.save("s", "原工作");
  const service = f.service({ judge: async input => {
    const current = f.storage.getSession("s")!;
    f.storage.saveSession({ ...current, messages: [...current.messages!, { role: "user", content: [{ type: "image", data: "sensitive-image-bytes" } as never] }] });
    assert.doesNotMatch(JSON.stringify(input), /sensitive-image-bytes/);return newGroup(input);
  } });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);
  assert.equal(job.result.refused.length, 1);assert.equal(job.result.createdTasks.length, 0);assert.equal(f.storage.getSession("s")?.workspaceTaskId, undefined);
});

test("tool context keeps resource metadata but excludes raw outputs, commands, written contents and hidden thinking", t => {
  const f = fixture(t);const session = f.save("s", "检查代码");
  const body = conversationContent({ ...session, messages: [...session.messages!, { role: "assistant", content: [
    { type: "tool_use", name: "write", input: { path: "/src/auth.ts", content: "private-code", command: "sensitive-command" } },
    { type: "tool_result", content: "private-output" } as never,
    { type: "thinking", thinking: "private-thought" } as never,
  ] }] }).text;
  assert.match(body, /\/src\/auth.ts/);assert.doesNotMatch(body, /private-code|sensitive-command|private-output|private-thought/);
});

test("redaction happens before any classification model sees conversation content", async t => {
  const f = fixture(t);f.save("s", "工作目标，password: SECRET_VALUE_12345");
  const service = f.service({ judge: async input => { assert.doesNotMatch(JSON.stringify(input), /SECRET_VALUE_12345/);return newGroup(input); } });
  const job = await done(service, service.start(service.prepare(f.scope).token).id);assert.equal(job.status, "completed");
});

test("system-call logs and private/automation sessions do not enter the work corpus", t => {
  const f = fixture(t);f.save("work", "真实工作");f.save("private", "不应读取", { automationId: "conversation-message:private" });f.save("scheduled", "不应读取", { sessionSource: "automation" });
  const log = systemAiSessions(f.storage).forEmployee(f.storage.getSystemSiliconEmployee()!).start("system-text", { system: "x", prompt: "y" }, f.root);log.complete();
  const read: string[] = [];
  const service = f.service({ getSession: id => { read.push(id);return f.storage.getSession(id); }, judge: async input => newGroup(input) });
  const preview = service.prepare(f.scope);assert.equal(preview.sessionCount, 1);assert.deepEqual(read, ["work"]);
  const extracted = conversationContent({ ...f.storage.getSession("work")!, messages: [{ role: "user", content: [{ type: "thinking", thinking: "hidden" } as never, { type: "text", text: "visible" }] }] });
  assert.match(extracted.text, /visible/);assert.doesNotMatch(extracted.text, /hidden/);
});
