import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTmuxTerminalHost } from "../src/tmux-terminal-host.js";
import { RenderDaemonClient } from "../src/render-daemon-client.js";
import type { TerminalAttachResult, TerminalHost, TerminalSpawnRequest } from "../src/terminal-host.js";

const request: TerminalSpawnRequest = { sessionId: "unknown", file: "/bin/sh", args: [], cwd: "/tmp", env: {}, name: "xterm", cols: 80, rows: 24 };
function fixture() {
  let disconnected = false;
  let forgotten = "";
  let starts = 0;
  const existing = { state: { sessionId: "old", status: "running" }, process: {}, replay: [], isNew: false } as TerminalAttachResult;
  const host: TerminalHost = {
    persistent: true,
    attach(id) { return id === "old" ? existing : null; },
    async createOrAttach() { starts++; return existing; },
    forget(id) { forgotten = id; },
    disconnect() { disconnected = true; },
  };
  return { host, existing, disconnected: () => disconnected, forgotten: () => forgotten, starts: () => starts };
}

for (const mode of ["required", "off"]) {
  test(`unavailable tmux does not prevent assembly, but blocks unknown owners (${mode})`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-routing-"));
    const original = process.env.WAND_TMUX_MODE;
    process.env.WAND_TMUX_MODE = mode;
    try {
      mkdirSync(path.join(root, "pty-tmux"));
      const f = fixture();
      const wrapped = await createTmuxTerminalHost(path.join(root, "config.json"), f.host,
        async () => { throw new Error("broken metadata or missing dependency"); });
      assert.equal(wrapped.client, null);
      assert.equal(wrapped.host.attach("old"), f.existing);
      assert.equal(await wrapped.host.createOrAttach({ ...request, sessionId: "old" }), f.existing);
      assert.throws(() => wrapped.host.attach("unknown"), /ownership is unavailable/);
      await assert.rejects(wrapped.host.createOrAttach(request), /ownership is unavailable/);
      assert.throws(() => wrapped.host.forget("unknown"), /ownership is unavailable/);
      await assert.rejects(wrapped.maintenanceTarget!.inspect(), /ownership is unavailable/);
      assert.equal(f.starts(), 0);
      wrapped.host.forget("old");
      assert.equal(f.forgotten(), "old");
      wrapped.host.disconnect();
      assert.equal(f.disconnected(), true);
    } finally {
      if (original === undefined) delete process.env.WAND_TMUX_MODE;
      else process.env.WAND_TMUX_MODE = original;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Render without authoritative connected inventory cannot authorize a new tmux execution", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-routing-"));
  const original = process.env.WAND_TMUX_MODE;
  process.env.WAND_TMUX_MODE = "required";
  const render = new RenderDaemonClient(path.join(root, "unused.sock"), "fixture");
  const fresh = fixture();
  try {
    const wrapped = await createTmuxTerminalHost(path.join(root, "config.json"), render, async () => fresh.host);
    assert.throws(() => wrapped.host.attach("unknown"), /authoritative inventory/);
    await assert.rejects(async () => wrapped.host.createOrAttach(request), /authoritative inventory/);
    assert.equal(fresh.starts(), 0);
    wrapped.host.disconnect();
    assert.equal(fresh.disconnected(), true);
  } finally {
    render.disconnect();
    if (original === undefined) delete process.env.WAND_TMUX_MODE;
    else process.env.WAND_TMUX_MODE = original;
    rmSync(root, { recursive: true, force: true });
  }
});
