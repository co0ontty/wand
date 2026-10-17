import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { WandStorage } from "../src/storage.js";
import type { TerminalAttachResult, TerminalHost, TerminalProcess, TerminalSpawnRequest } from "../src/terminal-host.js";
import type { ProcessEvent } from "../src/types.js";

function harness(t: test.TestContext, persistent = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-start-lifecycle-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const pending: Array<{ request: TerminalSpawnRequest; resolve(value: TerminalAttachResult): void; reject(error: Error): void }> = [];
  const forgotten: string[] = [];
  const host: TerminalHost = {
    persistent, attach() { return null; },
    createOrAttach(request) { return new Promise((resolve, reject) => pending.push({ request, resolve, reject })); },
    forget(id) { forgotten.push(id); }, disconnect() {},
  };
  const manager = new ProcessManager({ ...defaultConfig(), defaultCwd: root, startupCommands: [], language: "" }, storage, root, host);
  const events: ProcessEvent[] = [];
  manager.on("process", (event: ProcessEvent) => events.push(event));
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const resolve = (index = 0) => {
    const { request } = pending[index];
    let kills = 0;
    const writes: string[] = [];
    const exits = new Set<Parameters<TerminalProcess["onExit"]>[0]>();
    const child: TerminalProcess = {
      sessionId: request.sessionId, incarnationId: `fixture-${index}`, pid: 0,
      kill() { kills++; }, write(text) { writes.push(text); }, resize() {},
      onData() { return { dispose() {} }; },
      onExit(listener) { exits.add(listener); return { dispose() { exits.delete(listener); } }; },
    };
    pending[index].resolve({ process: child, replay: [], isNew: true, state: {
      sessionId: request.sessionId, incarnationId: child.incarnationId, pid: 0, status: "running", exitCode: null,
      cols: 120, rows: 36, seq: 0, output: "", chunks: [], terminalSnapshot: null, launchMarkerToken: null,
    } });
    return { kills: () => kills, writes, exit: (exitCode = 0) => { for (const listener of [...exits]) listener({ exitCode }); } };
  };
  return { root, storage, manager, pending, resolve, events, forgotten };
}

for (const persistent of [false, true]) {
  for (const action of ["stop", "delete", "dispose"] as const) {
    test(`pending ${persistent ? "persistent" : "local"} start cannot undo ${action}`, async t => {
      const h = harness(t, persistent);
      const start = h.manager.startShell(h.root, "default");
      const id = h.pending[0].request.sessionId;
      if (action === "dispose") h.manager.dispose();
      else h.manager[action](id);
      const completion = assert.rejects(start, /取消|cancelled/i);
      const child = h.resolve();
      await completion;
      assert.equal(child.kills(), action === "dispose" && persistent ? 0 : 1);
      assert.deepEqual(child.writes, []);
      assert.equal(h.events.some(e => e.type === "started"), false);
      if (action === "delete") assert.equal(h.storage.getSession(id), null);
      else assert.equal(h.storage.getSession(id)?.status, action === "dispose" && persistent ? "running" : "stopped");
    });
  }
}

for (const action of ["stop", "delete", "dispose"] as const) {
  test(`late spawn failure does not remove state owned by ${action}`, async t => {
    const h = harness(t, true);
    const start = h.manager.startShell(h.root, "default");
    const id = h.pending[0].request.sessionId;
    if (action === "dispose") h.manager.dispose();
    else h.manager[action](id);
    const completion = assert.rejects(start, /取消|cancelled/i);
    h.pending[0].reject(new Error("fixture spawn failed"));
    await completion;
    if (action === "delete") assert.equal(h.storage.getSession(id), null);
    else assert.equal(h.storage.getSession(id)?.status, action === "dispose" ? "running" : "stopped");
  });
}

test("same-id reuse is refused while a start owns the host handshake; settled cancellation permits reuse", async t => {
  const h = harness(t);
  const first = h.manager.start("sh", h.root, "default", undefined, { interactiveShell: true, reuseId: "same" });
  const rejected = assert.rejects(first, /取消|cancelled/i);
  h.manager.stop("same");
  await assert.rejects(h.manager.start("sh", h.root, "default", undefined,
    { interactiveShell: true, reuseId: "same" }), /启动.*进行|starting/i);
  assert.equal(h.pending.length, 1);
  const oldChild = h.resolve();
  await rejected;
  const next = h.manager.start("sh", h.root, "default", undefined, { interactiveShell: true, reuseId: "same" });
  const newChild = h.resolve(1);
  assert.equal((await next).status, "running");
  assert.equal(oldChild.kills(), 1);
  assert.equal(newChild.kills(), 0);
});

test("native cleanup keeps persistent PTY handles until exit acknowledgement", async t => {
  const h = harness(t, true);
  const start = h.manager.startShell(h.root, "default");
  const child = h.resolve();
  const session = await start;
  const barrier = h.manager.nativeHistoryCleanupBarrier(session.id);
  assert.ok(barrier);
  h.manager.delete(session.id);
  assert.equal(child.kills(), 1);
  assert.deepEqual(h.forgotten, []);
  let settled = false;
  void barrier.then(() => { settled = true; });
  child.exit(-1);
  await Promise.resolve();
  assert.equal(settled, false, "missing remote inventory is not an acknowledged exit");
  child.exit();
  await barrier;
  await Promise.resolve();
  assert.deepEqual(h.forgotten, [session.id]);
});

test("uncancelled startup failure still removes its own provisional record", async t => {
  const h = harness(t);
  const start = h.manager.startShell(h.root, "default");
  const id = h.pending[0].request.sessionId;
  const completion = assert.rejects(start, /fixture unavailable/);
  h.pending[0].reject(new Error("fixture unavailable"));
  await completion;
  assert.equal(h.storage.getSession(id), null);
});
