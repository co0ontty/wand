import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { CompositeTerminalHost } from "../src/render-host.js";
import { WandStorage } from "../src/storage.js";
import type { TerminalDataEvent, TerminalHost, TerminalProcess, TerminalSpawnRequest } from "../src/terminal-host.js";

class BatchedTestHost implements TerminalHost {
  readonly persistent = true;
  listener: ((event: TerminalDataEvent) => void) | null = null;
  pending = "";
  seq = 0;
  killed = false;
  disconnected = false;
  attach() { return null; }
  forget() {}
  flush() {
    if (!this.pending || !this.listener) return;
    const data = this.pending;
    this.pending = "";
    this.listener({ data, seq: ++this.seq });
  }
  disconnect() { this.disconnected = true; }
  async createOrAttach(request: TerminalSpawnRequest) {
    const process: TerminalProcess = {
      sessionId: request.sessionId, incarnationId: "test-incarnation", pid: 999999,
      write() {}, resize() {}, kill: () => { this.killed = true; },
      onData: listener => { this.listener = listener; return { dispose: () => { this.listener = null; } }; },
      onExit: () => ({ dispose() {} }),
    };
    return { process, isNew: true, replay: [], state: {
      sessionId: request.sessionId, incarnationId: "test-incarnation", pid: process.pid,
      status: "running" as const, exitCode: null, cols: request.cols, rows: request.rows,
      seq: 0, output: "", chunks: [], terminalSnapshot: null, launchMarkerToken: null,
    } };
  }
}

test("snapshots and owner teardown flush accepted IPC bytes without stopping persistent PTYs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wand-batched-output-"));
  const storage = new WandStorage(join(dir, "wand.db"));
  const host = new BatchedTestHost();
  const composite = new CompositeTerminalHost({ legacy: null, render: host });
  const manager = new ProcessManager({ ...defaultConfig(), defaultCwd: dir }, storage, dir, composite, {
    samplePtyForegrounds: () => new Map(),
  });
  try {
    const session = await manager.startShell(dir, "default");
    host.pending = "accepted before snapshot\r\n";
    assert.equal(manager.getOwned(session.id)?.output, "accepted before snapshot\r\n");
    host.pending = "accepted before terminal state\r\n";
    manager.getTerminalState(session.id);
    assert.equal(host.pending, "");
    host.pending = "final accepted bytes\r\n";
    manager.dispose();
    const persisted = storage.getSession(session.id)!;
    assert.equal(persisted.output, "accepted before snapshot\r\naccepted before terminal state\r\nfinal accepted bytes\r\n");
    assert.equal(persisted.ptyOutputSeq, 3);
    assert.equal(persisted.status, "running");
    assert.equal(host.killed, false);
    assert.equal(host.disconnected, true);
  } finally {
    manager.dispose();
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
