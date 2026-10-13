import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { TerminalHost } from "../src/terminal-host.js";

for (const autoArchiveEnabled of [false, true]) {
  test(`structured restoration leaves retention to the service (enabled=${autoArchiveEnabled})`, t => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-retention-"));
    const storage = new WandStorage(path.join(root, "wand.db"));
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    storage.saveSession({ id: "old", command: "claude -p", sessionKind: "structured", provider: "claude",
      cwd: root, mode: "default", status: "idle", exitCode: 0, startedAt: old, endedAt: old, output: "history", archived: false });
    const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root, startupCommands: [],
      taskRetention: { autoArchiveEnabled, autoArchiveDays: 365, autoDeleteEnabled: false, autoDeleteDays: 365 },
    });
    t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
    assert.equal(storage.getSession("old")?.archived, false);
    assert.equal(manager.get("old")?.archived, false);
  });
  test(`PTY restoration never applies a second retention policy (enabled=${autoArchiveEnabled})`, t => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-manager-retention-"));
    const storage = new WandStorage(path.join(root, "wand.db"));
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    storage.saveSession({ id: "old", command: "sh", cwd: root, mode: "default", status: "exited", exitCode: 0,
      startedAt: old, endedAt: old, output: "history", archived: false });
    const manager = new ProcessManager({ ...defaultConfig(), defaultCwd: root, startupCommands: [],
      taskRetention: { autoArchiveEnabled, autoArchiveDays: 365, autoDeleteEnabled: false, autoDeleteDays: 365 },
    }, storage, root);
    t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
    assert.equal(storage.getSession("old")?.archived, false);
    assert.equal(manager.get("old")?.archived, false);
  });
}

test("starting the 201st cached session cannot delete retained history or logs", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-manager-retention-cap-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  for (let i = 0; i < 200; i++) storage.saveSession({ id: `old-${i}`, command: "sh", cwd: root, mode: "default", status: "exited",
    exitCode: 0, startedAt: old, endedAt: old, output: "retained history", archived: true, archivedAt: old });
  const host: TerminalHost = {
    persistent: false, attach() { return null; }, forget() {}, disconnect() {},
    async createOrAttach(request) {
      const process = { sessionId: request.sessionId, incarnationId: "fixture", pid: 0, kill() {}, write() {}, resize() {},
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
      return { process, replay: [], isNew: true, state: { sessionId: request.sessionId, incarnationId: "fixture", pid: 0,
        status: "running", exitCode: null, cols: 120, rows: 36, seq: 0, output: "", chunks: [], terminalSnapshot: null,
        launchMarkerToken: null } };
    },
  };
  const manager = new ProcessManager({ ...defaultConfig(), defaultCwd: root, startupCommands: [],
    taskRetention: { autoArchiveEnabled: false, autoArchiveDays: 7, autoDeleteEnabled: false, autoDeleteDays: 7 },
  }, storage, root, host);
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const deleteSession = t.mock.method(storage, "deleteSession");
  await manager.startShell(root, "default");
  assert.equal(deleteSession.mock.callCount(), 0);
  assert.equal(storage.loadSessionsSlim().length, 201);
  for (let i = 0; i < 200; i++) assert.equal(storage.getSession(`old-${i}`)?.output, "retained history");
});
