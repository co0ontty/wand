import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerTaskRoutes } from "../src/server-task-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { WandTaskComment } from "../src/task-types.js";

/**
 * `#TASK-xxx` 引用的完整链路：
 * 引用只认本任务的直接子任务；合法引用随派发一起交给执行者；非法引用整条评论被拒。
 */
test("task comment references: only own children resolve, and the reference reaches the dispatched agent", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-comment-reference-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root };
  const manager = new StructuredSessionManager(storage, config);
  const registry = new SessionRegistry({ getOwned: () => null, getOwnedSlim: () => null } as never, manager, storage);
  const sent: Array<{ prompt: string }> = [];
  manager.sendMessage = ((_id: string, prompt: string) => { sent.push({ prompt }); return Promise.resolve(); }) as typeof manager.sendMessage;
  const app = express(); app.use(express.json());
  registerTaskRoutes(app, { storage, config, structured: manager, sessions: registry, generateTitle: async () => "test title" });
  app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const parent = storage.createWandTask({ title: "parent" });
  const child = storage.createWandTask({ title: "child", parentTaskId: parent.id });
  const other = storage.createWandTask({ title: "other" });
  const employee = storage.ensureDefaultSiliconEmployee();
  const post = (body: object) => fetch(`${url}/api/wand-tasks/${parent.id}/comments`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async (response: Response) => (await response.json() as { comment: WandTaskComment }).comment;
  try {
    // 1. 合法引用：整条评论保存，引用进入派发提示词。
    const referenced = await read(await post({ requestId: "reference-001", body: `请处理 #${child.identifier}`, employeeId: employee.id }));
    assert.equal(referenced.dispatch?.state, "accepted");
    assert.deepEqual(referenced.dispatch?.referencedTaskIds, [child.id]);
    assert.deepEqual(referenced.referencedTaskIds, [child.id]);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.prompt.includes(child.identifier), "the referenced identifier reaches the agent");
    assert.ok(sent[0]!.prompt.includes(child.id), "the referenced task id reaches the agent");
    assert.ok(sent[0]!.prompt.includes(`请处理 #${child.identifier}`), "the full instruction still reaches the agent");

    // 2. 多个引用：按正文出现顺序全部保留，但只派发一次。
    const second = storage.createWandTask({ title: "second child", parentTaskId: parent.id });
    const multi = await read(await post({ requestId: "reference-002", body: `先做 #${child.identifier} 再做 #${second.identifier}`, employeeId: employee.id }));
    assert.deepEqual(multi.dispatch?.referencedTaskIds, [child.id, second.id]);
    assert.equal(sent.length, 2, "multiple references still dispatch exactly once");
    assert.ok(sent[1]!.prompt.includes(child.identifier) && sent[1]!.prompt.includes(second.identifier));

    // 3. 非法引用（不属于本任务的子任务）：整条评论被拒，不会保存，也不会派发。
    const before = storage.listWandTaskComments(parent.id).length;
    const rejected = await post({ requestId: "reference-003", body: `处理 #${other.identifier}`, employeeId: employee.id });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json() as { error: string }).error, /引用的任务不存在或不属于当前任务/);
    assert.equal(storage.listWandTaskComments(parent.id).length, before, "a rejected reference saves no comment");
    assert.equal(sent.length, 2, "a rejected reference starts no execution");

    // 4. 普通评论里的引用（没有 @ 选中）：不派发，但引用仍然记录在评论上。
    const plain = await read(await post({ requestId: "reference-004", body: `只是记一下 #${child.identifier}` }));
    assert.equal(plain.dispatch, null);
    assert.deepEqual(plain.referencedTaskIds, [child.id]);
    assert.equal(sent.length, 2, "text without a chosen employee never dispatches");

    // 5. 同一 requestId 重放：不会二次派发。
    await post({ requestId: "reference-001", body: `请处理 #${child.identifier}`, employeeId: employee.id });
    assert.equal(sent.length, 2, "replaying a request never restarts the execution");
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    manager.dispose(); storage.close();
  }
});
