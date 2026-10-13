import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ConversationService } from "../src/conversation-service.js";
import { employeeConversationId } from "../src/conversation-types.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ConversationSessionUpdate, ConversationInstance } from "../src/conversation-types.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

// No model input: exercise real creation/selection events and persisted association separately from execution.
test("real workspace creation events attach the same session to the employee DM before any input", async t => {
  const h = conversationHarness(t);
  const manager = new StructuredSessionManager(h.storage, h.config, null);
  const updates: ConversationSessionUpdate[] = [];
  const service = new ConversationService({ ...h, structured: manager, notifySession: update => updates.push(update) });
  t.after(() => { service.dispose(); manager.dispose(); });
  manager.setEventEmitter(event => service.ingestSessionEvent(event));
  const original = manager.createSession({ cwd: h.cwd, mode: "default", provider: "claude",
    employeeId: "e_test_1", employeeName: "员工 1", workspaceId: h.workspace.id });
  const dm = employeeConversationId("e_test_1");
  assert.equal(service.list().find(item => item.id === dm)?.peerEmployeeId, "e_test_1");
  assert.equal(service.detail(dm).messages[0]?.sessionLink?.sessionId, original.id);
  assert.equal(h.storage.getSession(original.id)?.workspaceId, h.workspace.id);
  assert.deepEqual(manager.get(original.id)?.messages, []);
  assert.equal(service.detail(employeeConversationId("e_test_2")).messages.length, 0);
  // Keep this event test independent of optional SDK harness availability.
  h.storage.saveSiliconEmployee({ ...h.storage.getSiliconEmployee("e_test_2")!, agents: [
    { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" },
  ] });
  // Identity selection before sending moves only the synthetic link, not the workspace or session.
  manager.setSessionEmployee(original.id, "e_test_2");
  assert.equal(service.list().some(item => item.id === dm), false);
  assert.equal(service.detail(employeeConversationId("e_test_2")).messages[0]?.sessionLink?.sessionId, original.id);
  assert.equal(manager.get(original.id)?.workspaceId, h.workspace.id);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(updates.at(-1)?.conversationId, employeeConversationId("e_test_2"));
  assert.equal(updates.at(-1)?.sessionId, original.id);
});

test("startup imports historical interactive sessions once and preserves source history, workspace and employees", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const session = h.structured.createSession({ cwd: h.cwd, mode: "default", provider: "claude", employeeId: "e_test_1",
    title: "项目里的旧工作", workspaceId: h.workspace.id });
  await h.structured.sendMessage(session.id, "明确测试替身输入");
  const original = JSON.stringify(h.storage.getSession(session.id));
  // GETs remain read-only; migration is explicit.
  assert.equal(h.service.list().length, 0);
  h.service.detail(dm);
  assert.equal(h.storage.listConversations().length, 0);
  h.service.migrateExistingChats(); h.service.migrateExistingChats();
  const detail = h.service.detail(dm);
  assert.equal(detail.messages.length, 1);
  assert.deepEqual(detail.messages[0]?.sessionLink, { sessionId: session.id, title: "项目里的旧工作" });
  assert.equal(detail.messages[0]?.sessionPreview?.text, "明确测试替身回复");
  assert.equal(JSON.stringify(h.storage.getSession(session.id)), original);
  assert.equal(h.sent.length, 1);
  assert.equal(h.storage.getConversationRequest(`employee-session:${session.id}`), null, "no invented delivery receipt");
  const reopened = new ConversationService({ ...h });
  reopened.migrateExistingChats();
  assert.equal(reopened.detail(dm).messages.length, 1);
  h.storage.saveSiliconEmployee({ ...h.storage.getSiliconEmployee("e_test_1")!, name: "改名员工" });
  assert.equal(reopened.list()[0]?.title, "改名员工");
  assert.equal(reopened.detail(employeeConversationId("e_test_2")).messages.length, 0);
});

test("migration excludes PTY, automation, task work, unbound roles, legacy channels and existing IM executions", async t => {
  const h = conversationHarness(t);
  const options = { cwd: h.cwd, mode: "default" as const, provider: "claude" as const, employeeId: "e_test_1" };
  for (const extra of [{ automationId: "ai-team:worker" }, { sessionSource: "automation" as const },
    { sessionSource: "startup" as const }, { workspaceTaskId: "task-owned" }, { employeeId: undefined }]) {
    h.structured.createSession({ ...options, ...extra });
  }
  const pty = h.structured.createSession(options);
  h.storage.saveSession({ ...pty, sessionKind: "pty" });
  const legacy = h.structured.createSession(options);
  const instance: ConversationInstance = { ...h.service.pendingEmployee("e_test_1"),
    communicationSessionId: legacy.id, createdAt: legacy.startedAt, updatedAt: legacy.startedAt };
  h.storage.saveConversation(instance);
  const receipt = await h.service.send(employeeConversationId("e_test_2"), randomUUID(), "已有私聊", null);
  const before = JSON.stringify(h.storage.conversationEvents(receipt.conversationId));
  h.service.migrateExistingChats();
  h.service.ingestSessionEvent({ type: "status", sessionId: legacy.id });
  assert.equal(h.storage.conversationEvents(instance.id).length, 0);
  assert.equal(JSON.stringify(h.storage.conversationEvents(receipt.conversationId)), before);
  assert.equal(h.storage.listConversations().length, 2);
});

test("events update exact links idempotently; deletion and late events do not resurrect work", async t => {
  const h = conversationHarness(t), dm = employeeConversationId("e_test_1");
  const one = h.structured.createSession({ cwd: h.cwd, mode: "default", provider: "claude", employeeId: "e_test_1" });
  const other = h.structured.createSession({ cwd: h.cwd, mode: "default", provider: "claude", employeeId: "e_test_2" });
  h.service.ingestSessionEvent({ type: "started", sessionId: one.id });
  h.service.importEmployeeSession(other);
  for (let i = 0; i < 20; i++) h.service.ingestSessionEvent({ type: "output", sessionId: one.id });
  assert.equal(h.storage.conversationEvents(dm).length, 1);
  const titled = { ...one, title: "真实生成的标题" };
  h.sessions.set(one.id, titled); h.storage.saveSession(titled);
  h.service.ingestSessionEvent({ type: "status", sessionId: one.id });
  assert.equal(h.service.detail(dm).messages[0]?.sessionLink?.title, titled.title);
  h.storage.updateConversationListState(dm, { deleting: true });
  h.service.importEmployeeSession({ ...one, title: "迟到标题" });
  assert.equal(h.service.detail(dm).messages[0]?.sessionLink?.title, titled.title);
  await h.service.remove(dm);
  assert.equal(h.storage.getSession(one.id), null);
  assert.ok(h.storage.getSession(other.id));
  h.service.ingestSessionEvent({ type: "status", sessionId: one.id });
  h.service.migrateExistingChats();
  assert.equal(h.service.list().some(item => item.id === dm), false);
});
