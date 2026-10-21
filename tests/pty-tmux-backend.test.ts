import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { connectExistingTerminalHost, type TerminalDaemonClient } from "../src/terminal-daemon-client.js";
import { ptyTmuxLogWriter } from "../src/pty-tmux-log.js";
import { PtyTmuxBackend } from "../src/pty-tmux-backend.js";

const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal output");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
test("tmux daemon reconnect and crash recovery do not replay commands", { timeout: 20000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-daemon-"));
  const config = path.join(root, "tmux-terminald.json");
  const launch = () => spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "fixtures/terminal-daemon-entry.ts"), config], { stdio: "ignore" });
  let daemon = launch();
  let client: TerminalDaemonClient | null = null;
  const connect = async () => {
    const deadline = Date.now() + 5000;
    while (!client) {
      client = await connectExistingTerminalHost(config);
      if (Date.now() > deadline) throw new Error("Daemon unavailable");
      if (!client) await new Promise(resolve => setTimeout(resolve, 30));
    }
    return client;
  };
  try {
    const first = await connect();
    const terminal = await first.createOrAttach({ sessionId: "persist", file: "/bin/sh", args: ["-i"], cwd: root,
      env: { PATH: process.env.PATH }, name: "xterm", cols: 80, rows: 24 });
    const pid = terminal.process!.pid;
    first.disconnect(); client = null;
    const second = await connect();
    assert.equal(second.attach("persist")!.state.pid, pid);
    assert.deepEqual(await second.request("shutdownIfIdle"), { accepted: false });
    second.disconnect(); client = null;
    const dead = once(daemon, "exit"); daemon.kill("SIGKILL"); await dead;
    process.kill(pid, 0);
    daemon = launch();
    const third = await connect();
    assert.equal(third.attach("persist")!.state.pid, pid);
    await third.request("kill", { sessionId: "persist", signal: "SIGKILL" });
    await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await third.request("forget", { sessionId: "persist" });
    assert.deepEqual(await third.request("list"), []);
    const launching = third.createOrAttach({ sessionId: "pending", file: "/bin/sh", args: ["-i"], cwd: root,
      env: { PATH: process.env.PATH }, name: "xterm", cols: 80, rows: 24 });
    const forgetting = third.request("forget", { sessionId: "pending" });
    const late = await launching;
    await forgetting;
    await wait(() => { try { process.kill(late.state.pid, 0); return false; } catch { return true; } });
    assert.deepEqual(await third.request("list"), []);
  } finally {
    client?.disconnect();
    const dead = once(daemon, "exit"); daemon.kill("SIGTERM"); await dead;
    rmSync(root, { recursive: true, force: true });
  }
});

test("lost pipe writer reports observation failure without acknowledging pane exit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-pipe-fail-"));
  const config = path.join(root, "tmux-terminald.json");
  const backend = new PtyTmuxBackend(config);
  const child = await backend.spawn({ sessionId: "lost-pipe", file: "/bin/sh", args: ["-i"], cwd: root,
    env: { PATH: process.env.PATH }, name: "xterm", cols: 80, rows: 24 });
  try {
    let output = ""; let exited = false;
    child.onData(data => { output += data; }); child.onExit(() => { exited = true; });
    const file = readdirSync(path.join(root, "pty-tmux")).find(file => file.endsWith(".json"))!;
    const record = JSON.parse(readFileSync(path.join(root, "pty-tmux", file), "utf8"));
    const hash = createHash("sha256").update(path.resolve(config)).digest("hex").slice(0, 20);
    execFileSync("tmux", ["-S", `/tmp/wand-pty-${process.getuid?.() ?? 0}-${hash}.sock`, "pipe-pane", "-t", `${record.name}:0.0`]);
    await wait(() => output.includes("observation failed"));
    assert.equal(exited, false);
    process.kill(child.pid, 0);
    assert.throws(() => child.write("unsafe retry"), /unavailable/);
    child.kill();
    assert.equal(exited, true);
    backend.forget("lost-pipe");
  } finally {
    try { child.kill(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("PTY log ring bounds disk while retaining a split provider marker", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-ring-"));
  const writer = spawn(process.execPath, ["-e", ptyTmuxLogWriter, root], { stdio: ["pipe", "ignore", "inherit"] });
  const done = once(writer, "exit");
  writer.stdin.write("\u001eWAND_CLI_");
  writer.stdin.write("EXIT:test:0\u001f");
  for (let i = 0; i < 12; i++) if (!writer.stdin.write(Buffer.alloc(1024 * 1024, 120))) await once(writer.stdin, "drain");
  writer.stdin.end();
  assert.equal((await done)[0], 0);
  const chunks = readdirSync(root).filter(file => file.endsWith(".chunk"));
  assert.ok(chunks.length <= 8);
  assert.ok(chunks.reduce((size, file) => size + statSync(path.join(root, file)).size, 0) <= 8 * 1024 * 1024);
  assert.equal(readFileSync(path.join(root, "marker"), "utf8"), "\u001eWAND_CLI_EXIT:test:0\u001f");
  rmSync(root, { recursive: true, force: true });
});

test("short-lived panes preserve raw control markers and actual exit code", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-short-"));
  const backend = new PtyTmuxBackend(path.join(root, "tmux-terminald.json"));
  try {
    for (let i = 0; i < 5; i++) {
      const child = await backend.spawn({ sessionId: `short-${i}`, file: "/bin/sh",
        args: ["-c", "printf '\\036WAND_CLI_EXIT:test:7\\037'; exit 7"], cwd: root,
        env: { PATH: process.env.PATH }, name: "xterm", cols: 80, rows: 24 });
      let output = "";
      let code: number | null = null;
      child.onData(data => { output += data; });
      child.onExit(event => { code = event.exitCode; });
      await wait(() => code !== null);
      assert.equal(code, 7);
      assert.ok(output.includes("\u001eWAND_CLI_EXIT:test:7\u001f"));
      backend.forget(`short-${i}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real tmux blank shell accepts split input, resizes, recovers and kills its actual shell", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-test-"));
  const config = path.join(directory, "tmux-terminald.json");
  const backend = new PtyTmuxBackend(config);
  const child = await backend.spawn({ sessionId: "blank", file: "/bin/sh", args: ["-i"], cwd: directory,
    env: { PATH: process.env.PATH, WAND_SECRET_FIXTURE: "not-in-metadata" }, name: "xterm-256color", cols: 80, rows: 24 });
  try {
    assert.ok(child.pid > 0);
    let output = "";
    child.onData(data => { output += data; });
    child.write("printf 'hello-tmux\\n'"); child.write("\r");
    await wait(() => output.includes("hello-tmux"));
    child.resize(100, 35);
    const metadata = readdirSync(path.join(directory, "pty-tmux")).filter(file => file.endsWith(".json")).map(file => readFileSync(path.join(directory, "pty-tmux", file), "utf8")).join("");
    assert.ok(!metadata.includes("not-in-metadata"));
    const recovered = new PtyTmuxBackend(config).recover();
    assert.equal(recovered[0].child.pid, child.pid);
    recovered[0].child.kill();
    await wait(() => { try { process.kill(child.pid, 0); return false; } catch { return true; } });
    backend.forget("blank");
  } finally {
    try { child.kill(); } catch { /* Already killed by recovered owner. */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
