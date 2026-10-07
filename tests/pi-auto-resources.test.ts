import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { withAutomaticPiResources } from "../src/pi-auto-resources.js";
import { decidePiCodemode } from "../src/pi-resource-recommendation.js";
import { piToolsArgs } from "../src/structured-pi-adapter.js";
import { CoreRunner } from "../src/core-runner.js";
import { defaultPiCliSessionSettings, patchPiSessionSettings, type PiResourceSelection } from "../src/pi-session-settings.js";
import { discoverPiResources, type PiResourceInventory } from "../src/pi-resource-catalog.js";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { ProcessManager } from "../src/process-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { DecisionResult } from "../src/decision-types.js";
import type { SessionSnapshot } from "../src/types.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerObserver, StructuredRunnerResult } from "../src/structured-runner.js";

const id = (value: string) => `skill-${value.repeat(24)}`;
const inventory: PiResourceInventory = {
  catalog: { supported: true, reason: "", skills: [
    { id: id("a"), name: "manual-pin", description: "Pinned resource", source: "已安装" },
    { id: id("b"), name: "auto-skill", description: "Create web pages", source: "已安装" },
  ], mcpServers: [] },
  skills: new Map([[id("a"), { name: "manual-pin" } as any], [id("b"), { name: "auto-skill" } as any]]), servers: new Map(),
};
const decision = (pick = true): DecisionResult => ({ model: "fixture", experimental: true, runtime: "laya-mlx",
  usage: { input_tokens: 20, output_tokens: 0, truncated: false },
  answers: {
    forward: { type: "choice", choice: pick ? "match" : "none", probabilities: { match: pick ? 1 : 0, none: pick ? 0 : 1 } },
    reverse: { type: "choice", choice: pick ? "match" : "none", probabilities: { match: pick ? 1 : 0, none: pick ? 0 : 1 } },
    relevant: { type: "noul", noul: pick ? 1 : 0 },
  } });
const requestedResource = (raw: any): string => typeof raw.state === "string"
  ? raw.questions.forward.criteria.match === "Batch tool calls" ? "CodeMode" : raw.questions.forward.criteria.match
  : raw.state.resource.name;
const success = (): StructuredRunnerResult => ({ state: { blocks: [{ type: "text", text: "done" }], result: "done", sessionId: null },
  exitCode: 0, signal: null, stderr: "", primaryError: null, inputAccepted: true });
const context = (): StructuredRunnerContext => ({ session: { id: "automatic", provider: "pi", sessionKind: "structured", cwd: tmpdir(),
  claudeSessionId: null, piSettings: { ...defaultPiCliSessionSettings(), autoResources: true,
    resources: { skills: [id("a")], mcpServers: [] }, lockedSkills: [id("a")] } } as SessionSnapshot, prompt: "设计页面", env: {} });
const observe = (): StructuredRunnerObserver & { updates: any[] } => {
  const updates: any[] = [];
  return { updates, isActive: () => true, onUpdate: (state) => updates.push(structuredClone(state)) };
};
const immediate = (start: (context: StructuredRunnerContext) => void): StructuredRunnerAdapter => ({ start(context, observer) {
  start(context); const result = success(); observer.onUpdate(result.state);
  return { args: ["pi"], pid: 1, spawnedAt: "", interrupt() {}, completion: Promise.resolve(result) };
} });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("automatic selection is off by default, strict opt-in, and completely bypassed when disabled", async () => {
  assert.equal(defaultPiCliSessionSettings().autoResources, false);
  assert.throws(() => patchPiSessionSettings(defaultPiCliSessionSettings(), { autoResources: "true" }));
  let starts = 0;
  const runner = withAutomaticPiResources(immediate(() => { starts++; }), {}, {
    inventory: async () => { throw new Error("must not discover"); }, evaluate: () => { throw new Error("must not evaluate"); },
  });
  const input = context(); input.session.piSettings!.autoResources = false;
  const observer = observe(); await runner.start(input, observer).completion;
  assert.equal(starts, 1); assert.equal(observer.updates.some((state) => state.resourceSelection), false);
});

test("selection happens after submission, preserves locked-on skills only for this round, and reports real names", async () => {
  const input = context(); const before = structuredClone(input);
  let captured: StructuredRunnerContext | undefined;
  const runner = withAutomaticPiResources(immediate((value) => { captured = value; }), {}, {
    inventory: async () => inventory, evaluate: () => async (raw) => decision(requestedResource(raw) === "auto-skill"),
  });
  const observer = observe(); const active = runner.start(input, observer);
  assert.equal(captured, undefined, "ownership must be returned before async matching");
  const result = await active.completion;
  assert.deepEqual(captured!.session.piSettings!.resources, { skills: [id("a"), id("b")], mcpServers: [] });
  assert.deepEqual(input, before, "automatic selection must not persist or mutate manual settings");
  assert.equal(observer.updates[0].resourceSelection.status, "selecting");
  assert.deepEqual(result.state.resourceSelection?.skills, ["manual-pin", "auto-skill"]);
  assert.match(result.state.resourceSelection?.label ?? "", /本轮选择.*manual-pin.*auto-skill/);
  assert.equal(result.state.blocks.some((block) => block.type === "tool_use"), false, "no fabricated provider tool call");
});

test("unlocked enabled skills can be omitted, while a locked enabled skill bypasses matching", async () => {
  const input = context(); input.session.piSettings!.lockedSkills = [];
  let selected: PiResourceSelection | undefined;
  const runner = withAutomaticPiResources(immediate((value) => { selected = value.session.piSettings!.resources; }), {}, {
    inventory: async () => inventory, evaluate: () => async (raw) => decision(requestedResource(raw) === "auto-skill"),
  });
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected?.skills, [id("b")], "an ordinary On position is not a permanent pin");
  assert.deepEqual(input.session.piSettings!.resources!.skills, [id("a")], "round choices never rewrite manual settings");
  input.session.piSettings!.lockedSkills = [id("a")];
  input.prompt = "不要 manual-pin，设计页面";
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected?.skills, [id("a"), id("b")], "the final lock position remains authoritative even if matching excludes it");
});

test("locked-off skills are not assessed or enabled, and unlocking restores automatic selection", async () => {
  const input = context(); input.session.piSettings!.lockedSkills = [id("a"), id("b")];
  const assessed: string[] = [];
  let selected: PiResourceSelection | undefined;
  const runner = withAutomaticPiResources(immediate((value) => { selected = value.session.piSettings!.resources; }), {}, {
    inventory: async () => inventory, evaluate: () => async (raw) => { assessed.push(requestedResource(raw)); return decision(); },
  });
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected?.skills, [id("a")]);
  assert.deepEqual(assessed, ["CodeMode"], "locked skills do not consume decision requests");
  input.session.piSettings!.lockedSkills = [id("a")];
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected?.skills, [id("a"), id("b")]);
});

test("unavailable or disabled local decision continues with manual pins and factual fallback text", async () => {
  for (const disabled of [false, true]) {
    const input = context(); input.session.piSettings!.localDecision = !disabled;
    let selected: any;
    const runner = withAutomaticPiResources(immediate((value) => { selected = value.session.piSettings!.resources; }), {}, {
      inventory: async () => inventory, evaluate: () => disabled ? () => { throw new Error("must not evaluate"); } : undefined,
    });
    const result = await runner.start(input, observe()).completion;
    assert.deepEqual(selected, input.session.piSettings!.resources);
    assert.equal(result.state.resourceSelection?.status, "fallback");
    assert.match(result.state.resourceSelection?.label ?? "", /沿用手选/);
    assert.equal(result.exitCode, 0);
  }
});

test("timeout settles even an evaluator ignoring cancellation; late judgments do not change the selected round", async () => {
  let release!: (result: DecisionResult) => void;
  let starts = 0;
  const runner = withAutomaticPiResources(immediate((value) => {
    starts++; assert.deepEqual(value.session.piSettings!.resources?.skills, [id("a")]);
  }), {}, { inventory: async () => inventory, timeoutMs: 15,
    evaluate: () => () => new Promise((resolve) => { release = resolve; }) });
  const result = await runner.start(context(), observe()).completion;
  assert.equal(starts, 1); assert.equal(result.state.resourceSelection?.status, "fallback");
  assert.match(result.state.resourceSelection?.label ?? "", /超时/);
  release(decision()); await tick(); assert.equal(starts, 1);
});

test("stop or lost ownership during matching never launches a late process", async () => {
  for (const stop of [true, false]) {
    let release!: (result: DecisionResult) => void, starts = 0;
    const runner = withAutomaticPiResources(immediate(() => { starts++; }), {}, { inventory: async () => inventory,
      evaluate: () => () => new Promise((resolve) => { release = resolve; }) });
    let owned = true; const observer = { ...observe(), isActive: () => owned };
    const active = runner.start(context(), observer);
    await tick(); assert.ok(release);
    if (stop) active.interrupt(); else owned = false;
    release(decision());
    const result = await active.completion;
    assert.equal(result.state.resourceSelection?.status, "cancelled");
    assert.equal(starts, 0); assert.equal(result.inputAccepted, false); assert.match(result.primaryError ?? "", /取消/);
  }
});

test("invalid manual pins fail before spawning; automatic picks cannot bypass a selected-resource constraint", async () => {
  const input = context(); input.session.piSettings!.resources!.skills = [id("0")];
  const runner = withAutomaticPiResources(immediate(() => { throw new Error("must not spawn"); }), {}, {
    inventory: async () => inventory, evaluate: () => async () => decision(),
  });
  const result = await runner.start(input, observe()).completion;
  assert.equal(result.inputAccepted, false); assert.equal(result.retryForbidden, true);
  assert.match(result.primaryError ?? "", /不存在/);
  assert.equal(result.state.resourceSelection?.status, "fallback");
  assert.match(result.state.resourceSelection?.label ?? "", /准备失败/);
});

test("long prompts continue unchanged while skipping bounded automatic matching", async () => {
  const input = context(); input.prompt = "长".repeat(1201);
  const runner = withAutomaticPiResources(immediate((received) => {
    assert.equal(received.prompt, input.prompt);
    assert.deepEqual(received.session.piSettings!.resources, input.session.piSettings!.resources);
  }), {}, { inventory: async () => inventory, evaluate: () => async () => { throw new Error("must not infer"); } });
  const result = await runner.start(input, observe()).completion;
  assert.equal(result.exitCode, 0); assert.equal(result.state.resourceSelection?.status, "fallback");
});

test("automatic CodeMode decisions affect the real CLI allowlist for this round without persisting the override", async () => {
  for (const enabled of [true, false]) {
    const input = context(); input.session.piSettings!.globalTools = false;
    let captured!: StructuredRunnerContext;
    const runner = withAutomaticPiResources(immediate((value) => { captured = value; }), {}, {
      inventory: async () => inventory, evaluate: () => async (raw) => decision(enabled && requestedResource(raw) === "CodeMode"),
    });
    const result = await runner.start(input, observe()).completion;
    assert.equal(captured.session.piSettings?.codemodeOverride, enabled ? "on" : "off");
    assert.equal(input.session.piSettings?.codemodeOverride, undefined);
    assert.equal(piToolsArgs(captured.session).join(",").includes("codemode"), enabled);
    assert.deepEqual(result.state.resourceSelection?.codemode, { mode: enabled ? "on" : "off", source: "automatic" });
    assert.match(result.state.resourceSelection?.label ?? "", enabled ? /CodeMode：启用/ : /CodeMode：关闭/);
  }
});

test("manual CodeMode off/on/only overrides automatic decisions and is reported as manual", async () => {
  for (const mode of ["off", "on", "only"] as const) {
    const input = context(); input.session.piSettings!.codemodeOverride = mode;
    const runner = withAutomaticPiResources(immediate((value) => {
      assert.equal(value.session.piSettings!.codemodeOverride, mode);
    }), {}, { inventory: async () => inventory, evaluate: () => async (raw) => {
      assert.notEqual(requestedResource(raw), "CodeMode", "manual mode must skip the automatic CodeMode question");
      return decision(false);
    } });
    const result = await runner.start(input, observe()).completion;
    assert.deepEqual(result.state.resourceSelection?.codemode, { mode, source: "manual" });
  }
});

test("explicit CodeMode requests/exclusions precede inference; uncertain answers preserve Pi configuration", async () => {
  const skipped = async (): Promise<DecisionResult> => { throw new Error("must not infer an explicit request"); };
  assert.deepEqual(await decidePiCodemode({ prompt: "使用 CodeMode 并发读取", evaluate: skipped, caller: "test" }), { override: "on", source: "explicit" });
  assert.deepEqual(await decidePiCodemode({ prompt: "不用 CodeMode，只改一行", evaluate: skipped, caller: "test" }), { override: "off", source: "explicit" });
  assert.deepEqual(await decidePiCodemode({ prompt: "CodeMode 也不要", evaluate: skipped, caller: "test" }), { override: "off", source: "explicit" });
  const input = context();
  let captured!: StructuredRunnerContext;
  const runner = withAutomaticPiResources(immediate((value) => { captured = value; }), {}, {
    inventory: async () => inventory, evaluate: () => async () => ({ ...decision(), answers: {
      ...decision().answers,
      reverse: { type: "choice", choice: "none", probabilities: { match: 0.04, none: 0.96 } },
    } }),
  });
  const result = await runner.start(input, observe()).completion;
  assert.equal(captured.session.piSettings?.codemodeOverride, undefined);
  assert.deepEqual(result.state.resourceSelection?.codemode, { mode: "follow", source: "uncertain" });
});

test("automatic selection never enables a globally disabled MCP; an explicit manual pin remains authoritative", async () => {
  const serverId = `mcp-${"d".repeat(24)}`;
  const withMcp: PiResourceInventory = { ...inventory,
    catalog: { ...inventory.catalog, mcpServers: [{ id: serverId, name: "docs", description: "Configured local MCP", source: "全局停用" }] },
    servers: new Map([[serverId, { name: "docs", config: { command: "test-only", enabled: false } } as any]]) };
  const selected: PiResourceSelection[] = [];
  const runner = withAutomaticPiResources(immediate((value) => { selected.push(value.session.piSettings!.resources!); }), {}, {
    inventory: async () => withMcp, evaluate: () => async () => decision(false),
  });
  const input = context(); input.prompt = "使用 docs 服务";
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected[0].mcpServers, []);
  input.session.piSettings!.resources!.mcpServers = [serverId];
  await runner.start(input, observe()).completion;
  assert.deepEqual(selected[1].mcpServers, [serverId]);
});

test("SDK rejects automatic resource selection before any model request or fallback", async () => {
  let resolved = false;
  const core = new CoreRunner({ config: defaultConfig(), modelResolver: async () => {
    resolved = true; throw new Error("must not request a model");
  } });
  const input = context(); delete input.session.piSettings!.resources;
  const result = await core.start(input, observe()).completion;
  assert.equal(resolved, false); assert.equal(result.inputAccepted, false);
  assert.equal(result.retryForbidden, true); assert.match(result.primaryError ?? "", /尚不支持/);
});

test("HTTP auto mode accepts immediately, queues during selection, recomputes each round and persists its notice", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-auto-resource-session-"));
  const agentDir = path.join(root, "agent");
  for (const name of ["manual-pin", "auto-skill"]) {
    const dir = path.join(agentDir, "skills", name); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Create web pages\n---\n# Resource\n`);
  }
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "cli" as const, agentDir },
    localDecision: { enabled: true, pythonPath: process.execPath, modelPath: root } };
  const real = await discoverPiResources(config, root);
  const pins = { skills: [real.catalog.skills.find((item) => item.name === "manual-pin")!.id], mcpServers: [] };
  const storage = new WandStorage(path.join(root, "wand.db"));
  let release!: () => void, calls = 0, pause = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const evaluate = async (raw: unknown): Promise<DecisionResult> => {
    calls++; await gate;
    if (pause) await new Promise<void>(() => {});
    const input = raw as { state: string | { task: string } };
    const prompt = typeof input.state === "string" ? input.state : input.state.task;
    return decision(prompt.includes("第一轮") && requestedResource(raw) === "auto-skill");
  };
  const seen: StructuredRunnerContext[] = [];
  const manager = new StructuredSessionManager(storage, config, null, { pi: immediate((value) => { seen.push(value); }) },
    undefined, () => ({ url: "http://127.0.0.1", evaluate }));
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, manager, storage);
  const app = express(); app.use(express.json());
  const decisions = { evaluate, status: () => ({ enabled: true, configured: true, supported: true }) } as any;
  registerSessionRoutes(app, processes, manager, storage, config.defaultMode, config, registry, undefined, undefined, decisions);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); server.close(); manager.dispose(); processes.dispose();
    await whenIterationPromptsSettled(); storage.close(); rmSync(root, { recursive: true, force: true });
  });
  const target = manager.createSession({ cwd: root, mode: "managed", provider: "pi" });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/${target.id}`;
  const post = (url: string, body: unknown, method = "POST") => fetch(endpoint + url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  assert.equal((await post("/pi-settings", { resources: pins, lockedSkills: pins.skills, autoResources: true }, "PATCH")).status, 200);
  const settingsResponse = await (await fetch(endpoint + "/pi-settings")).json() as any;
  assert.equal(settingsResponse.skillLocksAvailable, true);
  assert.deepEqual(settingsResponse.settings.lockedSkills, pins.skills);
  assert.equal((await post("/pi-settings", { lockedSkills: [id("0")] }, "PATCH")).status, 400);
  assert.deepEqual(storage.getSession(target.id)?.piSettings?.lockedSkills, pins.skills);
  const response = await post("/input", { input: "第一轮制作网站" });
  assert.equal(response.status, 202, "send must return before matching finishes even without a client preflight");
  assert.equal(seen.length, 0);
  assert.equal((await post("/input", { input: "第二轮修后端" })).status, 202);
  assert.deepEqual(manager.get(target.id)?.queuedMessages, ["第二轮修后端"]);
  release();
  for (let i = 0; i < 200 && (seen.length !== 2 || manager.get(target.id)?.structuredState?.inFlight); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.length, 2);
  assert.ok(seen[0].session.piSettings?.resources?.skills.includes(real.catalog.skills.find((item) => item.name === "auto-skill")!.id));
  assert.deepEqual(seen[1].session.piSettings?.resources, pins, "an automatic choice must not leak into the following round");
  assert.deepEqual(manager.get(target.id)?.piSettings?.resources, pins);
  const notices = manager.get(target.id)?.messages?.filter((turn) => turn.role === "assistant").map((turn) => turn.resourceSelection);
  assert.equal(notices?.length, 2);
  assert.deepEqual(notices?.[0]?.skills, ["manual-pin", "auto-skill"]);
  assert.deepEqual(notices?.[1]?.skills, ["manual-pin"]);
  assert.ok(calls > 1);
  assert.deepEqual(storage.getSession(target.id)?.messages?.filter((turn) => turn.role === "assistant").map((turn) => turn.resourceSelection), notices);
  assert.equal((await post("/pi-settings", { autoResources: false }, "PATCH")).status, 200);
  assert.deepEqual(manager.get(target.id)?.piSettings?.resources, pins);
  assert.equal((await post("/pi-settings", { localDecision: false }, "PATCH")).status, 200);
  assert.equal((await post("/pi-settings", { autoResources: true }, "PATCH")).status, 400,
    "a disabled local runtime cannot silently enable automatic selection");
  assert.equal(manager.get(target.id)?.piSettings?.autoResources, false);
  assert.equal((await post("/pi-settings", { localDecision: true, autoResources: true }, "PATCH")).status, 200);
  pause = true;
  assert.equal((await post("/input", { input: "第三轮等待取消" })).status, 202);
  for (let i = 0; i < 100 && manager.get(target.id)?.messages?.at(-1)?.resourceSelection?.status !== "selecting"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cancelled = manager.stop(target.id);
  assert.equal(cancelled.messages?.at(-1)?.resourceSelection?.status, "cancelled");
  assert.match(cancelled.messages?.at(-1)?.resourceSelection?.label ?? "", /已取消/);
  assert.ok(cancelled.messages?.at(-1)?.completedAt);
  await tick(); assert.equal(seen.length, 2, "stop during matching cannot launch another process");
});
