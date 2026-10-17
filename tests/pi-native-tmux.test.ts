import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildChildEnv } from "../src/env-utils.js";
import { PiRunner, buildPiNativeArgs } from "../src/structured-pi-adapter.js";
import { PiTmuxHost } from "../src/pi-tmux-host.js";
import nativeBridge from "../src/pi-native-event-bridge.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StructuredExecHost } from "../src/structured-exec-host.js";
import type { SessionSnapshot } from "../src/types.js";

const exec = promisify(execFile);
const waitFor = async (fn: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error(`timeout: ${label}`);
};
const legacy = (): StructuredExecHost => ({
  persistent: true, async spawnStructured() { throw new Error("native Pi must not execute the legacy pipe path"); },
  async attachRun() { return null; }, async adoptRun() { return null; }, async listRuns() { return []; }, forgetRun() {},
});

const snapshot = (id: string, cwd: string): SessionSnapshot => ({ id, cwd, provider: "pi", command: "pi", mode: "managed",
  selectedModel: "nativeFixture/probe", thinkingEffort: "off", claudeSessionId: null,
  structuredState: { provider: "pi", runner: "pi-cli-json", engine: "cli", inFlight: true, activeRequestId: id, lastError: null },
} as SessionSnapshot);

test("native Pi arguments preserve configuration without JSON/print/RPC mode", () => {
  const args = buildPiNativeArgs(snapshot("args", os.tmpdir()), "hello", ["--no-skills"]);
  assert.ok(!args.includes("--print") && !args.includes("--mode"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(args.some((value) => /pi-native-event-bridge\.(?:js|ts)$/.test(value)));
  assert.equal(args.at(-1), "hello");
});

test("real native Pi runs in default tmux with same-process event files and cleans up on completion/cancel", { timeout: 90000 }, async (t) => {
  const env = buildChildEnv(false, { PI_OFFLINE: "1" });
  if (spawnSync("tmux", ["-V"], { env }).status !== 0 || spawnSync("pi", ["--version"], { env }).status !== 0) { t.skip("tmux/Pi CLI unavailable"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-test-"));
  const agent = path.join(root, "agent"); mkdirSync(agent);
  const responses: Array<import("node:http").ServerResponse> = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _part of req) {}
    requests++; responses.push(res);
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: { role: "assistant", content: "真实原生界面：中文🙂" }, finish_reason: null }] })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { nativeFixture: { baseUrl: base + "/v1", api: "openai-completions", apiKey: "SYNTHETIC_TEST_KEY", models: [{ id: "probe", name: "Native fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [], defaultTools: [], defaultProjectTrust: "never", fullscreen: true }));
  const host = new PiTmuxHost(root, legacy());
  const runner = new PiRunner(undefined, host, agent);
  let active = true;
  const current = snapshot("native-live", root);
  const updates: string[] = [];
  const run = runner.start({ session: current, prompt: "本地原生验证", env }, { isActive: () => active, onUpdate: (state) => updates.push(state.result) });
  void run.completion.then((result) => t.diagnostic(JSON.stringify({ exitCode: result.exitCode, primaryError: result.primaryError,
    spawnError: result.spawnError?.message, stderr: result.stderr.slice(-1000) })));
  const findJob = () => {
    const slot = readdirSync(path.join(root, "pi-native"))[0];
    const file = path.join(root, "pi-native", slot ?? "none", "current.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { tmux: string; events: string; ready: string } : null;
  };
  t.after(async () => {
    const nativeRoot = path.join(root, "pi-native");
    for (const entry of readdirSync(nativeRoot, { recursive: true })) {
      if (String(entry).endsWith("state.json") || String(entry).endsWith("stderr.log") || String(entry).endsWith("worker-startup.log")) {
        t.diagnostic(`${entry}: ${readFileSync(path.join(nativeRoot, String(entry)), "utf8").slice(-2500)}`);
      }
    }
    const job = findJob();
    if (job && existsSync(job.events)) {
      const diagnostic = { requests, updates: updates.length, eventBytes: readFileSync(job.events).length,
        ready: existsSync(job.ready) ? readFileSync(job.ready, "utf8") : "missing",
        state: readFileSync(path.join(path.dirname(job.events), "state.json"), "utf8"),
        stderr: readFileSync(path.join(path.dirname(job.events), "stderr.log"), "utf8").slice(-2000) };
      t.diagnostic(JSON.stringify(diagnostic));
    }
    active = false;
    run.interrupt(); host.forgetRun("structured:native-live"); host.forgetRun("structured:native-cancel");
    for (const res of responses) res.destroy();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 300)); rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => updates.some((text) => text.includes("真实原生界面")), "file updates before exit");
  const job = findJob()!; assert.ok(job);
  assert.match((await exec("tmux", ["list-sessions", "-F", "#{session_name}"])).stdout, new RegExp(job.tmux));
  // File events can precede the TUI's next render frame. Wait for the actual
  // pane, not merely the protocol event, before asserting visible output.
  let screen = "";
  await waitFor(async () => {
    screen = (await exec("tmux", ["capture-pane", "-p", "-t", job.tmux])).stdout;
    return screen.includes("真实原生界面");
  }, "native pane renders streamed text");
  assert.match(screen, /真实原生界面/); assert.ok(!screen.includes('"assistantMessageEvent"'));
  const ready = JSON.parse(readFileSync(job.ready, "utf8")); assert.equal(ready.mode, "tui"); assert.equal(ready.hasUI, true);
  assert.match(readFileSync(job.events, "utf8"), /"message_update"/);
  const adoptedHost = new PiTmuxHost(root, legacy());
  const adoptedState = await adoptedHost.attachRun("structured:native-live");
  assert.equal(adoptedState?.nativeFile, job.events);
  assert.equal(adoptedState?.pid, ready.pid);
  const adopted = await adoptedHost.adoptRun("structured:native-live");
  assert.ok(adopted);
  let adoptedTail = "";
  let adoptedDone = false;
  adopted.onStream((event) => { if (event.stream === "stdout") adoptedTail += event.data; });
  adopted.onExit(() => { adoptedDone = true; });
  responses[0].end(`data: ${JSON.stringify({ id: "native", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  const done = await run.completion; assert.equal(done.exitCode, 0, done.stderr); assert.equal(done.state.result, "真实原生界面：中文🙂");
  await waitFor(() => adoptedDone, "second observer receives real CLI exit");
  assert.ok(!adoptedTail.includes('"type":"session"'), "adoption does not repeat the snapshot prefix");
  host.forgetRun("structured:native-live");
  await waitFor(async () => { try { await exec("tmux", ["has-session", "-t", job.tmux]); return false; } catch { return true; } }, "finished tmux removed");
  const cancel = runner.start({ session: snapshot("native-cancel", root), prompt: "取消本地任务", env }, { isActive: () => true, onUpdate() {} });
  await waitFor(() => requests === 2, "second local request");
  cancel.interrupt(); host.forgetRun("structured:native-cancel");
  const cancelled = await cancel.completion; assert.ok(cancelled.signal !== null || cancelled.exitCode !== 0);
  assert.equal(requests, 2, "no repeated submission or cloud calls");
});

test("native host keeps other providers with their original execution host", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-legacy-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = legacy(); let called = false;
  base.spawnStructured = async (request) => { called = true; assert.equal(request.file, "codex"); return { runId: request.runId, incarnationId: "legacy", pid: 42, interrupt() {}, onStream() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } }; };
  const host = new PiTmuxHost(root, base);
  await host.spawnStructured({ runId: "structured:codex", file: "codex", args: [], cwd: root, env: {} });
  assert.equal(called, true);
});

test("an existing daemon-owned Pi run is not migrated or mistaken for a new input acknowledgement", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-existing-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = legacy(); let adopted = false;
  base.attachRun = async () => ({ runId: "structured:old", incarnationId: "original", pid: 42, status: "running", exitCode: null, signal: null, stdoutSeq: 0, stderrSeq: 0, stdoutLog: "", stderrLog: "", stdoutTruncated: false, stderrTruncated: false });
  base.adoptRun = async () => { adopted = true; return null; };
  const host = new PiTmuxHost(root, base);
  await assert.rejects(host.spawnStructured({ runId: "structured:old", requestId: "new", nativePi: true, file: "pi", args: [], cwd: root, env: {} }), (error: unknown) => !!error && typeof error === "object" && "preflightBlocked" in error);
  assert.equal(adopted, false);
  assert.deepEqual(readdirSync(path.join(root, "pi-native")), []);
});

test("native event write failure stops the source process instead of silently losing structured output", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-write-failure-"));
  const paths = path.join(root, "paths.json");
  writeFileSync(paths, JSON.stringify({ events: root, ready: path.join(root, "ready.json") }));
  const previous = process.env.WAND_PI_NATIVE_PATHS; process.env.WAND_PI_NATIVE_PATHS = paths;
  t.after(() => { if (previous === undefined) delete process.env.WAND_PI_NATIVE_PATHS; else process.env.WAND_PI_NATIVE_PATHS = previous; rmSync(root, { recursive: true, force: true }); });
  const kill = t.mock.method(process, "kill", () => true);
  const callbacks = new Map<string, (event: unknown) => void>();
  nativeBridge({ on(name: string, callback: (event: unknown) => void) { callbacks.set(name, callback); } } as unknown as ExtensionAPI);
  assert.throws(() => callbacks.get("message_end")!({ type: "message_end", message: { role: "assistant", content: [] } }));
  assert.equal(kill.mock.calls.length, 1);
  assert.deepEqual(kill.mock.calls[0].arguments, [process.pid, "SIGTERM"]);
  callbacks.get("message_end")!({ type: "message_end", message: { role: "assistant", content: [] } });
  assert.equal(kill.mock.calls.length, 1, "failure termination is idempotent");
});

test("native launch aborted before handoff never creates a tmux execution", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-native-cancel-start-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  const host = new PiTmuxHost(root, legacy());
  await assert.rejects(host.spawnStructured({ runId: "structured:cancel-before", nativePi: true, file: "pi", args: [], cwd: root, env: {}, launchSignal: controller.signal }), /取消/);
  assert.deepEqual(readdirSync(path.join(root, "pi-native")), []);
});
