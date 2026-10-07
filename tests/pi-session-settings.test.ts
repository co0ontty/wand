import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { defaultConfig } from "../src/config.js";
import { CoreRunner, type CoreRunnerOptions } from "../src/core-runner.js";
import { installedPiExtensions } from "../src/pi-extension-resources.js";
import { cliPiSettingsRejection, defaultPiSessionSettings, effectivePiSessionSettings, isPiSettingsDraft, patchPiSessionSettings, piToolSelection, type PiSessionSettings } from "../src/pi-session-settings.js";
import { buildPiArgs, piToolsArgs } from "../src/structured-pi-adapter.js";
import { parseHarnessExtensionState } from "../src/core-extension-host.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { SessionRegistry } from "../src/session-registry.js";
import { toSessionDetailDTO, toSessionListItemDTO } from "../src/session-transport.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { SessionSnapshot } from "../src/types.js";
import { getErrorMessage } from "../src/error-utils.js";

/** 拒绝写入时要看到真实原因，而不是断言是否抛错。 */
function rejectionMessage(run: () => unknown): string {
  try { run(); } catch (error) { return getErrorMessage(error); }
  return "";
}
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerResult } from "../src/structured-runner.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-pi-settings-"));
  const agentDir = path.join(root, "agent"); mkdirSync(agentDir);
  const config = { ...defaultConfig(), defaultCwd: root, harness: { engine: "core" as const, agentDir } };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target: SessionSnapshot = { id: "pi-test", sessionKind: "structured", provider: "pi", runner: "pi-cli-json",
    command: "pi", cwd: root, mode: "managed", status: "idle", exitCode: null, startedAt: new Date().toISOString(),
    endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null, messages: [],
    piSettings: defaultPiSessionSettings(), systemPrompt: "WAND_SESSION_RULE" };
  return { root, agentDir, config, target };
}
function scripted(config: ReturnType<typeof fixture>["config"], responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0],
  options: { contextWindow?: number; decisionAccess?: CoreRunnerOptions["decisionAccess"] } = {}) {
  const core = createFauxCore({ models: [{ id: "pi-settings-faux", contextWindow: options.contextWindow ?? 200_000, maxTokens: 8000 }] });
  core.setResponses(responses);
  const requests: unknown[] = [];
  const runner = new CoreRunner({ config, decisionAccess: options.decisionAccess, modelResolver: async () => ({ model: core.getModel(), providerId: "faux", modelId: "pi-settings-faux", subscription: false }),
    streamFn: (model, context, options) => { requests.push(context); return core.streamSimple(model, context, options); } });
  return { core, runner, requests };
}
const run = (runner: CoreRunner, target: SessionSnapshot, prompt = "使用已启用工具") => runner.start({ session: target, prompt, env: process.env }, { isActive: () => true, onUpdate() {} }).completion;

function installFixture(agentDir: string) {  const goalDir = path.join(agentDir, "npm/node_modules/pi-goal"); mkdirSync(goalDir, { recursive: true });
  writeFileSync(path.join(goalDir, "package.json"), JSON.stringify({ name: "pi-goal", version: "1.0.0", pi: { extensions: ["index.js"] } }));
  writeFileSync(path.join(goalDir, "index.js"), `let goal = null;
    export default function(pi) {
      pi.on("session_start", (_, ctx) => { goal = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-goal").at(-1)?.data ?? null; });
      pi.registerTool({ name:"create_goal", label:"目标", description:"设置目标", parameters:{type:"object",properties:{objective:{type:"string"}},required:["objective"]},
        async execute(_id, args) { goal = args.objective; pi.appendEntry("pi-goal", goal); return {content:[{type:"text",text:goal}]}; } });
      pi.registerTool({ name:"get_goal", label:"目标", description:"读取目标", parameters:{type:"object",properties:{}},
        async execute() { return {content:[{type:"text",text:goal ?? "NONE"}]}; } });
    }`);
  const extension = path.join(agentDir, "extension.js");
  writeFileSync(extension, `export default function(pi) { pi.registerTool({name:"global_echo",label:"全局",description:"全局测试工具",parameters:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:"GLOBAL_OK"}]};}}); }`);
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-goal", "npm:uninstalled-wand-fixture"], extensions: [extension] }));
}

test("Pi settings: optional capabilities default off; partial updates are strict and do not mutate", () => {
  const defaults = defaultPiSessionSettings(false);
  assert.deepEqual(defaults, { codemode: "off", globalTools: false, goalMode: false, tools: ["read", "bash", "edit", "write"], localDecision: true, autoCompaction: false });
  assert.equal(patchPiSessionSettings(defaults, { codemode: "only" }).codemode, "only");
  assert.equal(defaults.codemode, "off");
  assert.deepEqual(patchPiSessionSettings(defaults, { tools: [] }).tools, []);
  for (const patch of [null, [], { codemode: true }, { goalMode: "false" }, { tools: ["read", "read"] }, { tools: ["evil"] }, { command: "sh" }]) {
    assert.throws(() => patchPiSessionSettings(defaults, patch));
  }
  for (const text of ["/", "/settings", "/co", "/codemode", "/tools", "/goal-mode"]) assert.equal(isPiSettingsDraft(text), true);
  for (const text of ["/goal review", "/tmp/file", "/unknown", "普通消息", "/settings\n任务", "/codemode on"]) assert.equal(isPiSettingsDraft(text), false);
});

test("CLI tool selection: Wand-managed allowlist, or follow Pi's own configuration", () => {
  const base = defaultPiSessionSettings();
  // 默认：只启用勾选的基础工具（与旧行为一致，不多带任何工具）。
  assert.deepEqual(piToolSelection(base), { mode: "allowlist", names: ["read", "bash", "edit", "write"] });
  assert.deepEqual(piToolsArgs({ piSettings: base }), ["--tools", "read,bash,edit,write"]);
  // CodeMode 在 CLI 靠白名单点名启用；`only` 没有对应开关，只能当「启用」。
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemode: "on" } }), ["--tools", "read,bash,edit,write,codemode"]);
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemode: "only" } }), ["--tools", "read,bash,edit,write,codemode"]);
  assert.equal(effectivePiSessionSettings({ ...base, codemode: "only" }, "cli").codemode, "on");
  assert.equal(effectivePiSessionSettings({ ...base, codemode: "only" }, "core").codemode, "only");
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemodeOverride: "on", tools: ["read"] } }), ["--tools", "read,codemode"]);
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemodeOverride: "only", tools: ["read"] } }), ["--tools", "read,codemode"]);
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemode: "on", codemodeOverride: "off" } }), ["--tools", "read,bash,edit,write"]);
  // 目标模式：pi-goal 的工具必须逐个点名，否则白名单会把它挡在外面。
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, codemode: "on", goalMode: true } }),
    ["--tools", "read,bash,edit,write,codemode,create_goal,get_goal,update_goal"]);
  // 什么都不勾 = --no-tools（仍然是白名单语义，不是「跟随 Pi 配置」）。
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, tools: [] } }), ["--no-tools"]);
  // 全局扩展工具：既不传 --tools 也不传 --exclude-tools，逐项开关在该模式下不参与启动参数。
  const global = { ...base, globalTools: true, codemode: "on" as const, goalMode: true, tools: [] as PiSessionSettings["tools"] };
  assert.deepEqual(piToolSelection(global), { mode: "config", names: [] });
  assert.deepEqual(piToolsArgs({ piSettings: global }), []);
  // 旧快照没有设置：不动参数，沿用 Pi 自身配置。
  assert.deepEqual(piToolsArgs({}), []);
  // 旧快照里未校验的名字不塞进白名单。
  assert.deepEqual(piToolsArgs({ piSettings: { ...base, tools: ["read", "evil"] as PiSessionSettings["tools"] } }), ["--tools", "read"]);
});

test("CLI writes reject what the engine cannot express", () => {
  const base = defaultPiSessionSettings();
  for (const patch of [{ tools: ["read"] }, { codemode: "on" }, { codemode: "off" }, { globalTools: true }, { goalMode: true }, { localDecision: false }]) {
    assert.equal(cliPiSettingsRejection(patch, patchPiSessionSettings(base, patch)), null, JSON.stringify(patch));
  }
  assert.match(cliPiSettingsRejection({ autoCompaction: false }, patchPiSessionSettings(base, { autoCompaction: false })) ?? "", /autoCompaction/);
  assert.match(cliPiSettingsRejection({ codemode: "only" }, patchPiSessionSettings(base, { codemode: "only" })) ?? "", /仅 CodeMode/);
});

test("新建 Pi 会话从第一轮起就带着设置；CLI 默认跟随 Pi 自身配置", async (t) => {
  const { root, config } = fixture(t);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const cli: StructuredRunnerAdapter = { start() { throw new Error("must not start"); } };
  const manager = new StructuredSessionManager(storage, config, null, { pi: cli });
  t.after(() => { manager.dispose(); storage.close(); });
  const created = manager.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.equal(created.piSettings?.globalTools, true, "CLI 出厂默认跟随 Pi 自身配置");
  // 与终端里直接跑 pi 一致：不传工具参数，用户的子代理/待办/CodeMode 不会因为从 Wand 启动就消失。
  assert.deepEqual(buildPiArgs(created, "任务"), [
    "--mode", "json", "--print", "--thinking", "off", "任务",
  ]);
  assert.deepEqual(manager.getPiSettings(created.id).settings, created.piSettings);
  // 旧快照（没有 piSettings）读出的设置与实际启动参数必须一致：都是跟随 Pi 配置。
  const legacy = { ...created, piSettings: undefined };
  assert.deepEqual(piToolsArgs(legacy), [], "旧快照不传工具参数");
  storage.saveSession(legacy);
  const reopened = new StructuredSessionManager(storage, config, null, { pi: cli });
  t.after(() => reopened.dispose());
  assert.equal(reopened.getPiSettings(created.id).resolution.engine, "cli");
  assert.equal(reopened.getPiSettings(created.id).settings.globalTools, true, "旧快照按 CLI 默认报告");
  // 关掉全局扩展才是 Wand 托管的逐项白名单。
  const managed = manager.setPiSettings(created.id, { globalTools: false });
  assert.deepEqual(piToolsArgs(managed), ["--tools", "read,bash,edit,write"]);
});

test("记住上次 Pi 设置：新建 CLI 会话直接起步，SDK 员工会话不受影响", async (t) => {
  const { root, config } = fixture(t);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const cli: StructuredRunnerAdapter = { start() { throw new Error("must not start"); } };
  const manager = new StructuredSessionManager(storage, config, null, { pi: cli });
  t.after(() => { manager.dispose(); storage.close(); });
  const pinned = { skills: [`skill-${"a".repeat(24)}`], mcpServers: [] };
  // 出厂：没有记住任何设置，新会话与终端里直接跑 pi 一致。
  assert.equal(storage.getPiSessionDefaults(), null);
  const first = manager.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.equal(first.piSettings?.autoResources, false);
  const saved = manager.setPiSettings(first.id, { autoResources: true, codemodeOverride: "on", resources: pinned,
    lockedSkills: pinned.skills, globalTools: false, tools: ["read"] });
  assert.deepEqual(storage.getPiSessionDefaults(), saved.piSettings,
    "保存成功后就成为新建 Pi 会话的默认设置");
  const next = manager.createSession({ cwd: root, mode: "managed", provider: "pi" });
  assert.equal(next.piSettings?.autoResources, true);
  assert.equal(next.piSettings?.codemodeOverride, "on");
  assert.deepEqual(next.piSettings?.resources, pinned);
  assert.deepEqual(next.piSettings?.lockedSkills, pinned.skills);
  assert.deepEqual(storage.getSession(next.id)?.piSettings?.lockedSkills, pinned.skills);
  assert.deepEqual(piToolsArgs(next), piToolsArgs(saved), "新会话首轮启动参数与面板显示的设置一致");
  // 已存在的会话保留自己的设置，不会被后来写入的默认重写。
  const other = manager.setPiSettings(next.id, { autoResources: false });
  assert.equal(manager.get(first.id)?.piSettings?.autoResources, true);
  assert.equal(other.piSettings?.autoResources, false);
  // 从别的 provider 切到 Pi 的空白会话与新建会话同等。
  const claude = manager.createSession({ cwd: root, mode: "managed", provider: "claude" });
  const switched = manager.setSessionProvider(claude.id, "pi");
  assert.equal(switched.piSettings?.autoResources, false, "继承的是最近一次写入的默认，不是出厂默认");
  assert.deepEqual(switched.piSettings?.resources, pinned);
  // SDK 员工会话不继承 CLI 专属的资源/CodeMode，也不写回默认。
  const defaultsBefore = JSON.stringify(storage.getPiSessionDefaults());
  const sdk = manager.createSession({ cwd: root, mode: "managed", provider: "pi", employeeCandidateIndex: 0,
    employeeCandidates: [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "managed", kind: "structured", engine: "sdk" }] });
  assert.equal(sdk.piSettings?.autoResources, undefined);
  assert.equal(sdk.piSettings?.resources, undefined);
  assert.equal(sdk.piSettings?.lockedSkills, undefined);
  assert.throws(() => manager.setPiSettings(sdk.id, { autoResources: true }), /SDK/);
  assert.throws(() => manager.setPiSettings(sdk.id, { lockedSkills: pinned.skills }), /SDK/);
  manager.setPiSettings(sdk.id, { globalTools: false });
  assert.equal(JSON.stringify(storage.getPiSessionDefaults()), defaultsBefore, "SDK 会话的改动不进默认记忆");
});

test("默认设置写坏/缺字段时退回出厂默认，不会静默开启能力", async (t) => {
  const { root } = fixture(t);
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  storage.setConfigValue("pref:piSessionDefaults", "{\"autoResources\":true}");
  const parsed = storage.getPiSessionDefaults();
  assert.equal(parsed?.autoResources, true, "合法字段仍然生效");
  assert.equal(parsed?.globalTools, true, "缺字段用 CLI 出厂值补齐，而不是凭空开启");
  assert.deepEqual(parsed?.tools, ["read", "bash", "edit", "write"]);
  storage.setConfigValue("pref:piSessionDefaults", "{\"codemode\":\"banana\"}");
  assert.equal(storage.getPiSessionDefaults(), null);
  storage.setConfigValue("pref:piSessionDefaults", "[1,2,3]");
  assert.equal(storage.getPiSessionDefaults(), null);
  storage.setConfigValue("pref:piSessionDefaults", "{\"unknown\":true}");
  assert.equal(storage.getPiSessionDefaults(), null);
  storage.setPiSessionDefaults(null);
  assert.equal(storage.getPiSessionDefaults(), null);
});

test("native CodeMode performs real read and stores state; only mode hides declarations, not callable tools", async (t) => {
  const { root, config, target } = fixture(t);
  writeFileSync(path.join(root, "fixture.txt"), "REAL_CODEMODE_READ");
  target.piSettings = { ...defaultPiSessionSettings(), codemode: "only", tools: ["read"] };
  const { runner, requests } = scripted(config, [
    fauxAssistantMessage([fauxToolCall("codemode", { code: 'console.log(await tools.read({path:"fixture.txt"})); store("round", 42);' }, "code-1")]),
    fauxAssistantMessage([fauxText("CodeMode 完成")]),
  ]);
  const result = await run(runner, target);
  assert.equal(result.primaryError, null);
  assert.ok(result.state.blocks.some((block) => block.type === "tool_result" && block.content.includes("REAL_CODEMODE_READ")));
  assert.ok(result.state.blocks.some((block) => block.type === "tool_use" && block.name === "Read"));
  assert.match(JSON.stringify(result.state.harnessExtensionState), /"round":42/);
  assert.match(JSON.stringify(requests[0]), /WAND_SESSION_RULE/);
  const serialized = JSON.stringify(requests[0]);
  assert.match(serialized, /codemode/);
  assert.doesNotMatch(serialized, /"name":"bash"|"name":"read"/);
  target.harnessExtensionState = result.state.harnessExtensionState;
  const replay = scripted(config, [fauxAssistantMessage([fauxToolCall("codemode", { code: 'console.log(load("round"));' })]), fauxAssistantMessage([fauxText("已恢复")])]);
  const replayed = await run(replay.runner, target);
  assert.equal(replayed.primaryError, null);
  assert.match(JSON.stringify(replayed.state.blocks), /42/);
});

test("CodeMode cannot indirectly execute a disabled bash tool", async (t) => {
  const { root, config, target } = fixture(t);
  target.piSettings = { ...defaultPiSessionSettings(), codemode: "on", tools: ["read"], localDecision: false };
  const { runner } = scripted(config, [fauxAssistantMessage([fauxToolCall("codemode", {
    code: 'await tools.bash({command:"touch SHOULD_NOT_EXIST"});',
  })]), fauxAssistantMessage([fauxText("工具不可用")])]);
  const result = await run(runner, target);
  assert.equal(result.primaryError, null);
  assert.equal(existsSync(path.join(root, "SHOULD_NOT_EXIST")), false);
  assert.ok(result.state.blocks.some((block) => block.type === "tool_result" && block.is_error));
});

test("installed global discovery skips missing packages and project extensions; goal is independent", async (t) => {
  const { root, agentDir, config, target } = fixture(t); installFixture(agentDir);
  mkdirSync(path.join(root, ".pi/extensions"), { recursive: true });
  writeFileSync(path.join(root, ".pi/extensions/evil.js"), 'throw new Error("PROJECT_CODE_MUST_NOT_LOAD");');
  const installed = await installedPiExtensions(config, root);
  assert.equal(installed.filter((entry) => entry.goal).length, 1);
  assert.equal(installed.filter((entry) => !entry.goal).length, 1);
  assert.equal(existsSync(path.join(agentDir, "npm/node_modules/uninstalled-wand-fixture")), false);
  target.piSettings = { ...defaultPiSessionSettings(), globalTools: true };
  const global = scripted(config, [fauxAssistantMessage([fauxToolCall("global_echo", {}, "global-1")]), fauxAssistantMessage([fauxText("全局工具完成")])]);
  const result = await run(global.runner, target);
  assert.equal(result.primaryError, null);
  assert.match(JSON.stringify(result.state.blocks), /GLOBAL_OK/);
  assert.doesNotMatch(JSON.stringify(global.requests[0]), /"name":"create_goal"/);
  target.piSettings = { ...defaultPiSessionSettings(), goalMode: true };
  const goal = scripted(config, [fauxAssistantMessage([fauxToolCall("create_goal", { objective: "ONLY_SESSION_A" })]), fauxAssistantMessage([fauxText("目标已设置")])]);
  const created = await run(goal.runner, target);
  assert.equal(created.primaryError, null);
  assert.doesNotMatch(JSON.stringify(goal.requests[0]), /global_echo/);
  target.harnessExtensionState = created.state.harnessExtensionState;
  const next = scripted(config, [fauxAssistantMessage([fauxToolCall("get_goal", {})]), fauxAssistantMessage([fauxText("目标已恢复")])]);
  assert.match(JSON.stringify((await run(next.runner, target)).state.blocks), /ONLY_SESSION_A/);
  const other = { ...target, id: "other", harnessExtensionState: undefined };
  const isolation = scripted(config, [fauxAssistantMessage([fauxToolCall("get_goal", {})]), fauxAssistantMessage([fauxText("另一个会话")])]);
  const isolated = await run(isolation.runner, other);
  assert.equal(isolated.primaryError, null);
  assert.doesNotMatch(JSON.stringify(isolated.state.blocks), /ONLY_SESSION_A/);
  assert.match(JSON.stringify(isolated.state.blocks), /NONE/);
});

test("Pi 主功能固定 CLI，基础工具设置映射到 CLI 参数", async (t) => {
  const { root, config, target } = fixture(t);
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  target.piSettings = { ...defaultPiSessionSettings(), tools: ["read"] };
  assert.deepEqual(buildPiArgs(target, "用户任务"), [
    "--mode", "json", "--print", "--tools", "read", "--thinking", "off", "--append-system-prompt", "WAND_SESSION_RULE", "用户任务",
  ]);
  target.harnessExtensionState = { entries: [{ type: "custom", customType: "pi-goal", data: "PRIVATE_STATE" }] };
  storage.saveSession(target);
  const restored = storage.getSession(target.id)!;
  assert.deepEqual(restored.piSettings, target.piSettings);
  assert.deepEqual(restored.harnessExtensionState, target.harnessExtensionState);
  assert.doesNotMatch(JSON.stringify(toSessionListItemDTO(restored)), /PRIVATE_STATE|harnessExtensionState/);
  assert.doesNotMatch(JSON.stringify(toSessionDetailDTO(restored)), /PRIVATE_STATE|harnessExtensionState/);
  assert.deepEqual(toSessionDetailDTO(restored).piSettings, target.piSettings);
  const manager = new StructuredSessionManager(storage, config, null, { core: scripted(config, [fauxAssistantMessage([fauxText("done")])]).runner });
  t.after(() => manager.dispose());
  assert.deepEqual(manager.getPiSettings(target.id).settings, target.piSettings);
  assert.equal(manager.getPiSettings(target.id).resolution.engine, "cli");
  // CLI 能表达的设置现在可以写入，但引擎表达不出的字段仍然被拒绝。
  assert.equal(manager.setPiSettings(target.id, { globalTools: true }).piSettings?.globalTools, true);
  assert.equal(manager.setPiSettings(target.id, { globalTools: false }).piSettings?.globalTools, false);
  assert.match(rejectionMessage(() => manager.setPiSettings(target.id, { autoCompaction: false })), /autoCompaction/);
  assert.match(rejectionMessage(() => manager.setPiSettings(target.id, { codemode: "only" })), /仅 CodeMode/);
  assert.equal(manager.setPiSettings(target.id, { codemode: "on" }).piSettings?.codemode, "on");
  assert.deepEqual(storage.getSession(target.id)?.piSettings, manager.getPiSettings(target.id).settings);  assert.equal(parseHarnessExtensionState({ entries: Array(129).fill({ type: "custom", customType: "huge" }) }), undefined);
});



test("HTTP Pi settings validates owner/engine/body, handles missing goal, and preserves history", async (t) => {
  const { root, agentDir, config } = fixture(t);
  const before = JSON.stringify({ extensions: [] }); writeFileSync(path.join(agentDir, "settings.json"), before);
  const storage = new WandStorage(path.join(root, "wand.db"));
  const core = scripted(config, [fauxAssistantMessage([fauxText("done")])]);
  const structured = new StructuredSessionManager(storage, config, null, { core: core.runner });
  const processes = new ProcessManager(config, storage, root);
  const registry = new SessionRegistry(processes, structured, storage);
  const app = express(); app.use(express.json()); registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, registry);
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); structured.dispose(); processes.dispose(); await whenIterationPromptsSettled(); storage.close(); });
  const target = structured.createSession({ cwd: root, mode: "managed", provider: "pi" });
  const url = `${base}/api/sessions/${target.id}/pi-settings`;
  const patch = (body: unknown) => fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const read = async () => (await fetch(url)).json() as Promise<{ engine: string; settings: PiSessionSettings; controls: Record<string, boolean> }>;
  const initial = await read();
  assert.equal(initial.engine, "cli");
  assert.deepEqual(initial.controls, { tools: true, codemode: true, codemodeOnly: false, globalTools: true,
    goalMode: false, localDecision: config.localDecision?.enabled === true, autoCompaction: false, codemodeOverride: true });
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await patch({ codemodeOverride: "only" })).status, 200);
  assert.equal((await read()).settings.codemodeOverride, "only");
  assert.equal((await patch({ codemodeOverride: null })).status, 200);
  assert.equal((await read()).settings.codemodeOverride, undefined);
  assert.equal((await patch({ codemodeOverride: "bogus" })).status, 400);
  assert.equal((await patch({ resources: { skills: [], mcpServers: [] } })).status, 200);
  assert.equal((await patch({ resources: { skills: ["skill-" + "0".repeat(24)], mcpServers: [] } })).status, 400);
  assert.equal((await patch({ resources: { skills: ["/tmp/SKILL.md"], mcpServers: [] } })).status, 400);
  assert.deepEqual(storage.getSession(target.id)?.piSettings?.resources, { skills: [], mcpServers: [] });
  assert.equal((await patch({ codemode: "only", tools: ["read"] })).status, 400);
  assert.equal((await patch({ tools: ["read"] })).status, 200);
  assert.equal((await patch({ tools: ["evil"] })).status, 400);
  assert.equal((await patch({ codemode: "on" })).status, 200);
  assert.equal((await patch({ globalTools: true })).status, 200);
  assert.equal((await patch({ autoCompaction: false })).status, 400);
  assert.equal((await patch({ goalMode: true })).status, 400);
  assert.equal((await patch({ agentDir: "/tmp/untrusted" })).status, 400);
  // 旧 SDK 会话留下的 `only` 在 CLI 下按「启用」报告：由 effectivePiSessionSettings 归一，
  // 这里核对无法通过接口写入的取值不会被伪装成生效值。
  assert.equal(effectivePiSessionSettings({ ...target.piSettings!, codemode: "only" }, "cli").codemode, "on");
  assert.equal((await fetch(`${base}/api/sessions/missing/pi-settings`)).status, 404);
  const other = structured.createSession({ cwd: root, mode: "managed", provider: "codex" });
  assert.equal((await fetch(`${base}/api/sessions/${other.id}/pi-settings`)).status, 400);
  assert.deepEqual(structured.get(target.id)?.messages, []);
  assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), before);
  assert.equal(storage.getSession(target.id)?.piSettings?.codemode, "on");
  assert.equal(storage.getSession(target.id)?.piSettings?.globalTools, true);
});

test("CLI Pi cannot silently accept native SDK settings", async (t) => {
  const { root, config, target } = fixture(t);
  const storage = new WandStorage(path.join(root, "wand.db")); storage.saveSession(target);
  const cli: StructuredRunnerAdapter = { start() { throw new Error("must not start"); } };
  const manager = new StructuredSessionManager(storage, config, null, { pi: cli });
  t.after(() => { manager.dispose(); storage.close(); });
  assert.equal(manager.getPiSettings(target.id).resolution.engine, "cli");
  assert.match(rejectionMessage(() => manager.setPiSettings(target.id, { autoCompaction: false })), /autoCompaction/);
  assert.match(rejectionMessage(() => manager.setPiSettings(target.id, { codemode: "only" })), /仅 CodeMode/);
  manager.setPiSettings(target.id, { tools: [] });
  assert.deepEqual(storage.getSession(target.id)?.piSettings?.tools, []);
});

test("session compaction and local decision switches override deployment defaults without removing history", async (t) => {
  const { config, target } = fixture(t);
  target.piSettings = { ...defaultPiSessionSettings(), autoCompaction: false, localDecision: false };
  target.messages = Array.from({ length: 8 }, (_, index) => ({ role: "user" as const,
    content: [{ type: "text" as const, text: `history-${index}: ${"long history ".repeat(120)}` }] }));
  const before = JSON.stringify(target.messages);
  const off = scripted(config, [fauxAssistantMessage("no extra summary")], {
    contextWindow: 1_000, decisionAccess: () => ({ url: "", evaluate: async () => { throw new Error("must not evaluate"); } }),
  });
  const result = await run(off.runner, target);
  assert.equal(result.primaryError, null);
  assert.equal(result.state.compaction, undefined);
  assert.equal(off.core.state.callCount, 1);
  assert.doesNotMatch(JSON.stringify(off.requests[0]), /"name":"decision_evaluate"/);
  assert.equal(JSON.stringify(target.messages), before);
});

test("stopping goal mode pauses its native state before abort and cannot restart via settle hooks", { timeout: 10_000 }, async (t) => {
  const { agentDir, config, target } = fixture(t); installFixture(agentDir);
  writeFileSync(path.join(agentDir, "npm/node_modules/pi-goal/index.js"), `let goal = null;
    export default function(pi) {
      pi.registerCommand("goal", {description:"pause", async handler(args) {
        if (args === "pause" && goal) { goal = {...goal,status:"paused"}; pi.appendEntry("pi-goal", goal); }
      }});
      pi.registerTool({name:"create_goal",label:"目标",description:"设置目标",parameters:{type:"object",properties:{}},
        async execute() { goal={status:"active"}; pi.appendEntry("pi-goal",goal); return {content:[{type:"text",text:"active"}]}; }});
      pi.on("agent_end", () => { if (goal?.status === "active") pi.sendUserMessage("CONTINUE_UNTIL_PAUSED",{deliverAs:"followUp"}); });
      pi.on("before_settle", () => { pi.sendUserMessage("SETTLE_MUST_NOT_RESTART",{deliverAs:"followUp"}); });
    }`);
  target.piSettings = { ...defaultPiSessionSettings(), goalMode: true };
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => { streamStarted = resolve; });
  const script = scripted(config, [fauxAssistantMessage([fauxToolCall("create_goal", {})]), async (_context, options) => {
    streamStarted();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage([], { stopReason: "aborted" });
  }]);
  const execution = script.runner.start({ session: target, prompt: "explicit goal request", env: process.env },
    { isActive: () => true, onUpdate() {} });
  t.after(() => execution.interrupt());
  await started;
  execution.interrupt(); execution.interrupt();
  const result = await execution.completion;
  assert.equal(result.primaryError, null);
  assert.equal(script.core.state.callCount, 2, "no continuation after Stop");
  assert.match(JSON.stringify(result.state.harnessExtensionState), /"status":"paused"/);
});
