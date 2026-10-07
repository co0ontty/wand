import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import { withModelGroups } from "../src/model-group-runner.js";
import { modelGroupSelector } from "../src/model-groups.js";
import { discoverPiResources } from "../src/pi-resource-catalog.js";
import { defaultPiCliSessionSettings } from "../src/pi-session-settings.js";
import { classifyProviderRejection, classifyStructuredFailure } from "../src/structured-failure.js";
import { PiRunner } from "../src/structured-pi-adapter.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerResult } from "../src/structured-runner.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { ProcessEvent, SessionSnapshot } from "../src/types.js";

const rejection = (message = "积分已耗尽，调用失败") => ({ role: "assistant", content: [], model: "fixture-model",
  stopReason: "error", errorMessage: message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
const reply = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "fixture-model" };
const events = (message: object = rejection()) => [
  { type: "session", id: "fixture-native-id" }, { type: "agent_start" }, { type: "turn_start" },
  { type: "message_end", message }, { type: "turn_end", message }, { type: "agent_end", messages: [message] },
];
const candidate = (provider: WandTaskAgent["provider"], model = "default"): WandTaskAgent => ({
  provider, model, kind: "structured", mode: "full-access", thinkingEffort: "off",
});
const result = (extra: Partial<StructuredRunnerResult> = {}): StructuredRunnerResult => ({
  state: { blocks: [], result: "", sessionId: null }, exitCode: 0, signal: null, stderr: "", primaryError: null, ...extra,
});
const success = () => result({ state: { blocks: [{ type: "text", text: "backup done" }], result: "backup done", sessionId: "backup-native" } });

/** The real Pi adapter parses deterministic protocol bytes; no model, CLI or MCP process is started. */
function replayPi(agentDir: string, lines: (model: string) => Array<object | string> | Error, spawned?: (model: string) => void): PiRunner {
  return new PiRunner(((_file, args) => {
    const argv = args as string[];
    const model = argv[argv.indexOf("--model") + 1] ?? "";
    spawned?.(model);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill(): boolean };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
    let stopped = false;
    child.kill = () => { stopped = true; setImmediate(() => child.emit("close", null, "SIGTERM")); return true; };
    setImmediate(() => {
      if (stopped) return;
      const output = lines(model);
      if (output instanceof Error) { child.emit("error", output); return; }
      child.stdout.emit("data", Buffer.from(output.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n"));
      child.emit("close", 0, null);
    });
    return child;
  }) as typeof spawn, undefined, agentDir);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-refusal-"));
  const agentDir = path.join(root, "agent"); mkdirSync(agentDir);
  const skill = path.join(agentDir, "skills", "fixture-skill"); mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture only\n---\nFixture instructions.\n");
  const storage = new WandStorage(path.join(root, "fixture.db"));
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir } };
  const managers: StructuredSessionManager[] = [];
  t.after(async () => {
    managers.forEach((manager) => manager.dispose());
    await whenIterationPromptsSettled(); storage.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, agentDir, storage, config, manager(pi: StructuredRunnerAdapter, codex?: StructuredRunnerAdapter) {
    const manager = new StructuredSessionManager(storage, config, null, { pi, ...(codex ? { codex } : {}) });
    managers.push(manager); return manager;
  } };
}

for (const [message, kind] of [
  ["积分已耗尽，调用失败", "quota"], ["insufficient_quota", "quota"], ["Your credit balance is too low", "quota"],
  ["Codex error: The usage limit has been reached", "quota"], ["Invalid API key", "authentication"],
  ["rate_limit_exceeded", "rate-limit"], ["model_not_found", "model-unavailable"],
  ["fetch failed", null], ["HTTP 503: insufficient_quota", null], ["408 request timed out", null],
  ["409 conflict", null], ["工具输出：积分已耗尽，调用失败", null],
] as const) {
  test(`provider refusal classifier: ${message}`, () => assert.equal(classifyProviderRejection(message), kind));
}

test("normalized refusal facts distinguish metadata from progress, unknown delivery and hard boundaries", () => {
  const refused = result({ primaryError: "积分已耗尽，调用失败", rejection: "quota", inputAccepted: false,
    state: { blocks: [], result: "", sessionId: "metadata-only" } });
  assert.deepEqual(classifyStructuredFailure(refused, { output: true }), { kind: "quota", delivery: "rejected", retryable: true });
  for (const changed of [
    { inputAccepted: true }, { retryForbidden: true }, { signal: "SIGTERM" as const },
    { state: { ...refused.state, blocks: [{ type: "tool_use" as const, id: "tool", name: "Bash", input: {} }] } },
    { state: { ...refused.state, usage: { inputTokens: 1 } } },
  ]) assert.equal(classifyStructuredFailure({ ...refused, ...changed })?.retryable, false);
  assert.equal(classifyStructuredFailure(refused, { progress: true })?.retryable, false);
  assert.equal(classifyStructuredFailure(result({ primaryError: "积分已耗尽，调用失败" }))?.retryable, false,
    "a display string alone cannot prove rejection");
  assert.equal(classifyStructuredFailure(result({ primaryError: "local rejection", inputAccepted: false }), { output: true })?.retryable, false);
});

for (const mode of ["refusal", "text", "thinking", "tool", "earlier-reply", "usage", "unknown", "noise"] as const) {
  test(`real Pi protocol refusal evidence: ${mode}`, async (t) => {
    const f = fixture(t);
    const extra: Array<object | string> = mode === "text" ? [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }]
      : mode === "thinking" ? [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } }]
      : mode === "tool" ? [{ type: "tool_execution_start", toolCallId: "work", toolName: "bash", args: {} }]
      : mode === "earlier-reply" ? [{ type: "message_end", message: { ...reply, content: [], usage: { input: 1, output: 0 } } }]
      : mode === "noise" ? ["unknown non-protocol output"] : [];
    const message = mode === "unknown" ? rejection("fetch failed") : mode === "usage"
      ? { ...rejection(), usage: { input: 1, output: 0 } } : rejection();
    const runner = replayPi(f.agentDir, () => [...extra, ...events(message)]);
    const execution = runner.start({ session: { id: "fixture", provider: "pi", cwd: f.root,
      piSettings: defaultPiCliSessionSettings(), claudeSessionId: null } as SessionSnapshot, prompt: "fixture", env: {} },
    { isActive: () => true, onUpdate() {} });
    const got = await execution.completion;
    assert.equal(got.rejection, mode === "refusal" ? "quota" : undefined);
    assert.equal(classifyStructuredFailure(got)?.retryable, mode === "refusal");
    assert.equal(got.exitCode, 0, "protocol error does not require a nonzero process exit");
  });
}

test("ordinary employee: Pi quota refusal with locked Skills/auto-selection switches to Codex once using its own settings", async (t) => {
  const f = fixture(t);
  let piStarts = 0;
  const backups: StructuredRunnerContext[] = [];
  const manager = f.manager(replayPi(f.agentDir, () => events(), () => piStarts++), { start(context) {
    backups.push(context);
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(success()) };
  } });
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access", model: "primary",
    automationId: "conversation-talk:dm_fixture", employeeId: "fixture", systemPrompt: "Retain this employee role",
    employeeCandidates: [candidate("pi", "primary"), candidate("codex")], employeeCandidateIndex: 0 });
  const inventory = await discoverPiResources(f.config, f.root);
  const skillId = inventory.catalog.skills.find((skill) => skill.name === "fixture-skill")!.id;
  manager.setPiSettings(session.id, { resources: { skills: [skillId], mcpServers: [] }, lockedSkills: [skillId],
    autoResources: true, localDecision: false, codemodeOverride: "off" });
  const notices: ProcessEvent[] = []; manager.setEventEmitter((event) => notices.push(event));
  const finished = await manager.sendMessage(session.id, "synthetic task", { idempotencyKey: "exact-input" });
  assert.equal(piStarts, 1); assert.equal(backups.length, 1);
  assert.equal(backups[0]!.session.piSettings, undefined, "do not pretend Pi skills/tools exist in Codex");
  assert.equal(backups[0]!.session.claudeSessionId, null, "never pass the rejected Pi native ID to Codex");
  assert.equal(backups[0]!.session.systemPrompt, "Retain this employee role");
  assert.equal(finished.status, "idle"); assert.equal(finished.provider, "codex");
  assert.equal(finished.employeeCandidateIndex, 1);
  assert.equal(finished.messages?.filter((turn) => turn.role === "user").length, 1);
  assert.equal(notices.filter((event) => event.type === "ended").length, 1, "do not publish a failed ending before fallback finishes");
  assert.ok(!notices.some((event) => (event.data as any)?.status === "failed"));
  await assert.rejects(manager.sendMessage(session.id, "synthetic task", { idempotencyKey: "exact-input" }), /重复/);
  assert.equal(backups.length, 1);
});

test("model groups consume the same verified rejection despite session and resource metadata", async (t) => {
  const f = fixture(t); const models: string[] = [];
  const group = { id: "fixture", provider: "pi" as const, name: "fixture", models: ["first", "second"] };
  const runner = withModelGroups(replayPi(f.agentDir, (model) => events(model === "first" ? rejection() : reply),
    (model) => models.push(model)), { ...f.config, modelGroups: [group] });
  const selectedModel = modelGroupSelector(group);
  const session = { id: "fixture", provider: "pi", cwd: f.root, piSettings: defaultPiCliSessionSettings(),
    selectedModel, claudeSessionId: null } as SessionSnapshot;
  const finished = await runner.start({ session, prompt: "synthetic", env: {} }, { isActive: () => true, onUpdate() {} }).completion;
  assert.deepEqual(models, ["first", "second"]); assert.equal(finished.state.result, "done");
  assert.equal(finished.failure, null); assert.equal(session.selectedModel, selectedModel);
});

test("candidate exhaustion is bounded and preserves a single input and the final real error", async (t) => {
  const f = fixture(t); const models: string[] = [];
  const manager = f.manager(replayPi(f.agentDir, () => events(), (model) => models.push(model)));
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access", model: "first", employeeId: "fixture",
    employeeCandidates: ["first", "second", "third"].map((model) => candidate("pi", model)), employeeCandidateIndex: 0 });
  await assert.rejects(manager.sendMessage(session.id, "synthetic"), /积分已耗尽/);
  assert.deepEqual(models, ["first", "second", "third"]);
  const failed = manager.get(session.id)!;
  assert.equal(failed.status, "failed"); assert.equal(failed.employeeCandidateIndex, 2);
  assert.equal(failed.messages?.filter((turn) => turn.role === "user").length, 1);
  assert.match(JSON.stringify(failed.messages?.at(-1)), /积分已耗尽/);
});

test("Pi internal recovery clears a superseded refusal instead of failing a later successful answer", async (t) => {
  const f = fixture(t);
  const manager = f.manager(replayPi(f.agentDir, () => [...events(),
    { type: "message_end", message: reply }, { type: "agent_end", messages: [rejection(), reply] }]));
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access" });
  const done = await manager.sendMessage(session.id, "synthetic");
  assert.equal(done.status, "idle"); assert.equal(done.structuredState?.lastError, null);
  assert.match(JSON.stringify(done.messages), /done/);
});

test("a missing Pi executable can switch tools after successful resource preparation", async (t) => {
  const f = fixture(t); let backups = 0;
  const manager = f.manager(replayPi(f.agentDir, () => Object.assign(new Error("missing Pi"), { code: "ENOENT" })),
    { start(context) { backups++; assert.equal(context.session.piSettings, undefined);
      return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(success()) }; } });
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access", employeeId: "fixture",
    employeeCandidates: [candidate("pi"), candidate("codex")], employeeCandidateIndex: 0 });
  const inventory = await discoverPiResources(f.config, f.root);
  manager.setPiSettings(session.id, { resources: { skills: [inventory.catalog.skills[0]!.id], mcpServers: [] },
    autoResources: true, localDecision: false });
  assert.equal((await manager.sendMessage(session.id, "synthetic")).provider, "codex");
  assert.equal(backups, 1);
});

test("late refused input after stop/new turn cannot start a backup or fail the newer turn", async (t) => {
  const f = fixture(t); let backups = 0;
  const settle: Array<(value: StructuredRunnerResult) => void> = [];
  const manager = f.manager({ start() { return { args: [], pid: null, spawnedAt: "", interrupt() {},
    completion: new Promise<StructuredRunnerResult>((resolve) => settle.push(resolve)) }; } },
  { start() { backups++; throw new Error("must not replay"); } });
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access", employeeId: "fixture",
    employeeCandidates: [candidate("pi"), candidate("codex")], employeeCandidateIndex: 0 });
  const old = manager.sendMessage(session.id, "old"); manager.stop(session.id);
  const next = manager.sendMessage(session.id, "new");
  const requestId = manager.get(session.id)!.structuredState!.activeRequestId;
  settle[0]!(result({ primaryError: "积分已耗尽，调用失败", rejection: "quota", inputAccepted: false }));
  await old;
  assert.equal(backups, 0); assert.equal(manager.get(session.id)!.structuredState!.activeRequestId, requestId);
  settle[1]!(success()); await next;
  assert.equal(manager.get(session.id)?.status, "idle");
});

for (const boundary of ["history", "manual-model", "transport", "progress", "free-price"] as const) {
  test(`employee fallback preserves ${boundary} boundary`, async (t) => {
    const f = fixture(t); let backups = 0;
    const pi = boundary === "free-price" ? { start() { return { args: [], pid: null, spawnedAt: "", interrupt() {},
      completion: Promise.resolve(result({ primaryError: "积分已耗尽，调用失败", inputAccepted: false, rejection: "quota", retryForbidden: true })) }; } }
      : replayPi(f.agentDir, () => [
        ...(boundary === "progress" ? [{ type: "tool_execution_start", toolCallId: "tool", toolName: "write", args: {} }] : []),
        ...events(boundary === "transport" ? rejection("fetch failed") : rejection()),
      ]);
    const manager = f.manager(pi, { start() { backups++; throw new Error("must not replay"); } });
    const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "full-access", model: "primary", employeeId: "fixture",
      employeeCandidates: [candidate("pi", "primary"), candidate("codex")], employeeCandidateIndex: 0 });
    if (boundary === "history") manager.appendRelayTurns(session.id, [{ role: "user", content: [{ type: "text", text: "prior input" }] },
      { role: "assistant", content: [{ type: "text", text: "prior answer" }] }]);
    if (boundary === "manual-model") manager.setSessionModel(session.id, "explicit-override");
    await assert.rejects(manager.sendMessage(session.id, "synthetic"));
    assert.equal(backups, 0); assert.equal(manager.get(session.id)?.provider, "pi");
    if (boundary === "history") assert.equal(manager.get(session.id)?.messages?.[1]?.content[0]?.type, "text");
    if (boundary === "progress") {
      assert.equal(manager.get(session.id)?.status, "failed");
      assert.ok(manager.get(session.id)?.messages?.some((turn) => turn.content.some((block) => block.type === "tool_use")),
        "a failed turn must not erase the work it already did");
    }
    if (boundary === "manual-model") assert.equal(manager.get(session.id)?.selectedModel, "explicit-override");
  });
}
