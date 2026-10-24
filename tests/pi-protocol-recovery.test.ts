import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config.js";
import { MAX_PROTOCOL_LINE_BYTES } from "../src/bounded-process-output.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { buildReplayProcessor } from "../src/structured-session-manager-replay.js";
import { structuredRunId, type StructuredExecHost, type StructuredRunState,
  type StructuredStreamEvent, type StructuredExitEvent } from "../src/structured-exec-host.js";
import type { SessionSnapshot } from "../src/types.js";

const large = "x".repeat(MAX_PROTOCOL_LINE_BYTES + 1);
const message = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason,
  content: [{ type: "text", text }], ...(stopReason === "error" ? { errorMessage: text } : {}) });
const line = (event: unknown) => JSON.stringify(event) + "\n";

async function fixture(t: TestContext, stdoutLog: string, status: "running" | "exited", native: boolean) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-large-replay-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const id = "pi-large-replay";
  storage.saveSession({ id, sessionKind: "structured", sessionSource: "interactive", provider: "pi", runner: "pi-cli-json",
    command: "pi", cwd: root, mode: "managed", status: "running", exitCode: null,
    startedAt: new Date().toISOString(), endedAt: null, output: "", archived: false, archivedAt: null,
    messages: [{ role: "user", content: [{ type: "text", text: "fixture only" }] }], queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", engine: "cli", inFlight: true,
      activeRequestId: "original-request", lastError: null } });
  const state: StructuredRunState = { runId: structuredRunId(id), incarnationId: "original-cli", pid: 42,
    status, exitCode: status === "exited" ? 0 : null, signal: null, stdoutSeq: 1, stderrSeq: 0,
    stdoutLog, stderrLog: "", stdoutTruncated: false, stderrTruncated: false,
    ...(native ? { nativeFile: path.join(root, "original.jsonl") } : {}) };
  let starts = 0;
  let stream: ((event: StructuredStreamEvent) => void) | undefined;
  let exit: ((event: StructuredExitEvent) => void) | undefined;
  const host: StructuredExecHost = { persistent: true,
    async spawnStructured() { starts++; throw new Error("recovery must not repeat input"); },
    async listRuns() { return [state]; }, async attachRun() { return state; },
    async adoptRun() { return { runId: state.runId, incarnationId: state.incarnationId, pid: state.pid,
      interrupt() {}, onStream(listener) { stream = listener; return { dispose() {} }; },
      onExit(listener) { exit = listener; return { dispose() {} }; } }; }, forgetRun() {} };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, {}, host);
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  await manager.recoverDetachedRuns();
  return { get: () => manager.get(id)!, starts: () => starts,
    send: (data: string) => stream?.({ stream: "stdout", seq: 2, data }), close: () => exit?.({ exitCode: 0, signal: null }) };
}

for (const native of [false, true]) {
  test(`large Pi detached ${native ? "native" : "file-capture"} replay and live tail share the streaming projection`, async (t) => {
    const end = line({ type: "agent_end", messages: [{ role: "toolResult", content: large }, message("恢复完成🙂")] });
    const split = 33333;
    const f = await fixture(t, line({ type: "turn_end", message: message("恢复完成🙂"), context: { data: large } })
      + end.slice(0, split), "running", native);
    assert.equal(f.get().output, "恢复完成🙂");
    f.send(end.slice(split));
    f.close();
    assert.equal(f.get().status, "idle");
    assert.equal(f.get().structuredState?.lastError, null);
    assert.equal(f.get().output, "恢复完成🙂");
    assert.equal(f.starts(), 0);
  });

  test(`exited ${native ? "native" : "file-capture"} replay validates a final big envelope without newline`, async (t) => {
    const f = await fixture(t, JSON.stringify({ type: "agent_end", messages: [{ role: "toolResult", content: large }, message("done")] }), "exited", native);
    assert.equal(f.get().status, "idle");
    assert.equal(f.get().output, "done");
    assert.equal(f.starts(), 0);
  });

  test(`large tool result ${native ? "native" : "file-capture"} recovery keeps errors, metadata and the final reply without respawning`, async (t) => {
    const tool = line({ result: { content: [{ type: "image", data: large, mimeType: "image/png" }],
      details: { mode: "parallel", state: "failed", asyncId: "original-receipt" } },
      toolCallId: "huge", type: "tool_execution_end", isError: true });
    const prefix = line({ type: "tool_execution_start", toolCallId: "huge", toolName: "subagent", args: {} });
    const split = 33333;
    const f = await fixture(t, prefix + tool.slice(0, split), "running", native);
    f.send(tool.slice(split) + line({ type: "agent_end", messages: [message("大结果后继续完成🙂")] }));
    f.close();
    assert.equal(f.get().status, "idle");
    assert.equal(f.get().structuredState?.lastError, null);
    assert.equal(f.get().output, "大结果后继续完成🙂");
    const blocks = f.get().messages.flatMap(m => m.content);
    const result = blocks.find(b => b.type === "tool_result");
    assert.equal(result?.type === "tool_result" && result.is_error, true);
    assert.match(JSON.stringify(result), /仅展示有界预览/);
    const use = blocks.find(b => b.type === "tool_use");
    assert.equal(use?.type === "tool_use" && use.execution?.state, "failed");
    assert.equal(f.starts(), 0);
  });

  test(`malformed ${native ? "native" : "file-capture"} recovery is unknown delivery, never a retry or false success`, async (t) => {
    const f = await fixture(t, line({ type: "message_end", message: message("accepted work") })
      + '{"type":"turn_end","context":"' + large, "exited", native);
    assert.equal(f.get().status, "failed");
    assert.match(f.get().structuredState?.lastError ?? "", /送达结果未知/);
    assert.ok(JSON.stringify(f.get().messages).includes("accepted work"), "failure preserves already accepted transcript");
    assert.equal(f.starts(), 0);
    assert.equal(f.get().structuredState?.inFlight, false);
  });
}

test("Pi replay matches live terminal error supersession after internal recovery", () => {
  const processor = buildReplayProcessor({ runner: "pi-cli-json", claudeSessionId: null } as SessionSnapshot);
  processor.feed(line({ type: "message_end", message: message("temporary upstream error", "error") }));
  assert.equal(processor.primaryError, "temporary upstream error");
  processor.feed(line({ type: "turn_end", message: message("completed") }));
  assert.equal(processor.primaryError, null);
  processor.feed(line({ type: "agent_end", messages: [message("terminal error", "error")] }));
  assert.equal(processor.primaryError, "terminal error");
});
