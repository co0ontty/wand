import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyStoragePreferences, defaultConfig, saveConfig, writePreferenceToStorage } from "../src/config.js";
import { FREE_MODEL_GROUP_ID, defaultModelGroupSelector, findModelGroup, modelGroupSelector, normalizeModelGroups, resolveModelGroupModels, type ModelGroup } from "../src/model-groups.js";
import { withModelGroups } from "../src/model-group-runner.js";
import { ModelCatalogService, withConfiguredDefaultModelLabels } from "../src/models.js";
import { SESSION_PROVIDERS } from "../src/provider-catalog.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter, StructuredRunnerObserver, StructuredRunnerResult } from "../src/structured-runner.js";
import type { SessionSnapshot } from "../src/types.js";
import { startServer } from "../src/server.js";
import { resolveSystemAiContext } from "../src/session-ai-context.js";
import { systemEmployeeDefinition } from "../src/system-employee.js";

const group = (provider: ModelGroup["provider"] = "pi"): ModelGroup => ({ id: "coding", provider, name: "编程分组", models: ["first", "second"] });
const state = (model = "first"): StructuredRunnerResult["state"] => ({ blocks: [], result: "", sessionId: null, model });
const success = (): StructuredRunnerResult => ({ state: { ...state("second"), result: "ok", blocks: [{ type: "text", text: "ok" }] },
  exitCode: 0, signal: null, stderr: "", primaryError: null, inputAccepted: true });
function session(provider: ModelGroup["provider"] = "pi"): SessionSnapshot {
  return { id: "group-session", provider, sessionKind: "structured", command: "pi", cwd: process.cwd(), mode: "managed",
    status: "idle", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, output: "", archived: false,
    archivedAt: null, claudeSessionId: null, selectedModel: modelGroupSelector(group(provider)), messages: [] } as SessionSnapshot;
}
const observer: StructuredRunnerObserver = { isActive: () => true, onUpdate() {} };

for (const provider of SESSION_PROVIDERS) {
  test(`${provider}: 分组标识稳定，顺序规范化保序，执行只传具体模型`, async () => {
    const selected = group(provider);
    const normalized = normalizeModelGroups([{ ...selected, name: "  编程分组 ", models: [" first ", "second"] }]);
    assert.deepEqual(normalized, [selected]);
    assert.equal(modelGroupSelector({ ...selected, name: "改名", models: ["second", "first"] }), modelGroupSelector(selected));
    assert.deepEqual(resolveModelGroupModels(normalized, provider, modelGroupSelector(selected)), ["first", "second"]);
    const seen: string[] = [];
    const runner: StructuredRunnerAdapter = { start(context) {
      seen.push(context.session.selectedModel!);
      return { args: [context.session.selectedModel!], pid: null, spawnedAt: new Date().toISOString(), interrupt() {},
        completion: Promise.resolve(success()) };
    } };
    const target = session(provider);
    const run = withModelGroups(runner, { ...defaultConfig(), modelGroups: normalized }).start({ session: target, prompt: "hello", env: {} }, observer);
    assert.deepEqual(seen, ["first"], "runner 必须在同一 tick 注册");
    await run.completion;
    assert.equal(target.selectedModel, modelGroupSelector(selected));
    assert.deepEqual(normalized, [selected]);
    assert.throws(() => resolveModelGroupModels(normalized, provider === "pi" ? "claude" : "pi", target.selectedModel), /删除、为空或不属于/);
  });
}

test("每次新下发都按当前分组重新启动，未选组时优先默认分组，名称选择也适用于所有 provider", async () => {
  const seen: string[] = [];
  const runner: StructuredRunnerAdapter = { start(context) {
    seen.push(context.session.selectedModel!);
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(success()) };
  } };
  const groups = normalizeModelGroups([
    { id: "coding", provider: "claude", name: "编程分组", models: ["claude-first"] },
    { id: "default", provider: "claude", name: "默认分组", models: ["claude-default"] },
  ]);
  const config = { ...defaultConfig(), defaultModel: "claude-native-default", modelGroups: groups };
  const first = { ...session("claude"), selectedModel: null };
  await withModelGroups(runner, config).start({ session: first, prompt: "first", env: {} }, observer).completion;
  const named = { ...first, selectedModel: "编程分组" };
  await withModelGroups(runner, config).start({ session: named, prompt: "second", env: {} }, observer).completion;
  assert.deepEqual(seen, ["claude-default", "claude-first"]);
});
test("没有显式分组时使用默认分组，显式分组名称按名称解析", () => {
  const groups = normalizeModelGroups([
    { id: "coding", provider: "pi", name: "编程分组", models: ["coding-primary", "coding-fallback"] },
    { id: "default", provider: "pi", name: "默认分组", models: ["default-primary"] },
    { id: "review", provider: "pi", name: "Review", models: ["review-primary"] },
  ]);
  assert.equal(defaultModelGroupSelector(groups, "pi"), modelGroupSelector(groups[1]!));
  assert.equal(findModelGroup(groups, "pi", "Review")?.id, "review");
  assert.deepEqual(resolveModelGroupModels(groups, "pi", "Review"), ["review-primary"]);
  assert.deepEqual(resolveModelGroupModels(groups, "pi", undefined, { preferDefault: true }), ["default-primary"]);
  assert.deepEqual(resolveModelGroupModels(groups, "pi", "default", { preferDefault: true }), ["default-primary"]);
});

test("没有任何分组时不伪造模型，继续交给工具自身默认模型", () => {
  assert.deepEqual(resolveModelGroupModels([], "claude", undefined, { preferDefault: true }), [""]);
  assert.deepEqual(resolveModelGroupModels([], "claude", "claude-sonnet"), ["claude-sonnet"]);
});
test("分组验证拒绝无界、嵌套、重复、默认哨兵及免费跨工具，不改原输入", () => {
  const original = group();
  for (const invalid of [null, {}, [{ ...original, models: [] }], [{ ...original, models: ["default"] }],
    [{ ...original, models: ["first", "first"] }], [{ ...original, models: [modelGroupSelector(original)] }],
    [{ ...original, models: ["wand-openrouter-free/auto"] }], [{ ...original, name: "x".repeat(41) }],
    [{ ...original, provider: "shell" }], [{ ...original, id: "../../" }], [original, original],
    [{ ...original, models: Array.from({ length: 33 }, (_, i) => `m${i}`) }],
    [{ ...original, provider: "claude", models: ["wand-openrouter-free/test"] }],
    [{ ...original, id: FREE_MODEL_GROUP_ID, name: "随便改名" }]]) {
    assert.throws(() => normalizeModelGroups(invalid));
  }
  assert.deepEqual(original.models, ["first", "second"]);
  assert.equal(modelGroupSelector({ id: FREE_MODEL_GROUP_ID, provider: "pi" }), "wand-openrouter-free/auto");
  assert.deepEqual(normalizeModelGroups([{ id: FREE_MODEL_GROUP_ID, provider: "pi", name: "免费分组", models: [] }])[0]!.models, []);
});

test("模型分组热偏好恢复保序且不写 config.json；历史选择仍是稳定分组", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-model-group-storage-"));
  const db = new WandStorage(path.join(root, "wand.db"));
  try {
    const config = defaultConfig();
    writePreferenceToStorage(config, db, "modelGroups", [group()]);
    assert.deepEqual(config.modelGroups, [group()]);
    assert.deepEqual(applyStoragePreferences(defaultConfig(), db).modelGroups, [group()]);
    await saveConfig(path.join(root, "config.json"), config);
    assert.equal("modelGroups" in JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")), false);
    assert.throws(() => writePreferenceToStorage(config, db, "modelGroups", [{ ...group(), models: [] }]));
    assert.deepEqual(db.getPreference("pref:modelGroups", []), [group()]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("仅明确未接受的失败按分组顺序降级；默认模型也可配置为分组", async () => {
  const seen: string[] = [];
  const runner: StructuredRunnerAdapter = { start(context) {
    seen.push(context.session.selectedModel!);
    const result = seen.length === 1 ? { state: state(), exitCode: 1, signal: null, stderr: "", primaryError: "未找到模型", inputAccepted: false } : success();
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(result) };
  } };
  const target = { ...session(), selectedModel: null };
  const config = { ...defaultConfig(), defaultPiModel: modelGroupSelector(group()), modelGroups: [group()] };
  assert.equal((await withModelGroups(runner, config).start({ session: target, prompt: "hello", env: {} }, observer).completion).state.result, "ok");
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(target.selectedModel, null);
});

test("跟随服务端默认免费分组时传递池选择器，不被 native 默认模型替换", async () => {
  const seen: string[] = [];
  const runner: StructuredRunnerAdapter = { start(context) {
    seen.push(context.session.selectedModel!);
    return { args: [], spawnedAt: "", pid: null, interrupt() {}, completion: Promise.resolve(success()) };
  } };
  const config = { ...defaultConfig(), defaultPiModel: "wand-openrouter-free/auto" };
  for (const selectedModel of [null, "default"]) {
    const target = { ...session(), selectedModel };
    await withModelGroups(runner, config).start({ session: target, prompt: "hello", env: {} }, observer).completion;
    assert.equal(target.selectedModel, selectedModel);
  }
  assert.deepEqual(seen, ["wand-openrouter-free/auto", "wand-openrouter-free/auto"]);
});

for (const mode of ["unknown", "accepted", "output", "tool", "stopped", "stale", "signal"]) {
  test(`分组降级安全边界：${mode} 不重发输入`, async () => {
    let calls = 0;
    const runner: StructuredRunnerAdapter = { start(_context, observed) {
      calls++;
      const result: StructuredRunnerResult = { state: state(), exitCode: 1, signal: mode === "signal" ? "SIGTERM" : null,
        stderr: "error", primaryError: "error", ...(mode === "unknown" ? {} : { inputAccepted: mode === "accepted" }) };
      if (mode === "output") { result.state.result = "partial"; observed.onStdout?.("partial"); }
      if (mode === "tool") { result.state.blocks = [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "echo hello" } }]; observed.onUpdate(result.state); }
      return { args: [], spawnedAt: "", pid: null, completion: Promise.resolve(result), interrupt() {} };
    } };
    const run = withModelGroups(runner, { ...defaultConfig(), modelGroups: [group()] }).start({ session: session(), prompt: "hello", env: {} },
      { ...observer, isActive: () => mode !== "stale" });
    if (mode === "stopped") run.interrupt();
    await run.completion;
    assert.equal(calls, 1);
  });
}

test("会话保存分组、状态报告实际模型；重排下一轮生效，不改历史", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-model-group-manager-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const seen: string[] = [];
  const config = { ...defaultConfig(), modelGroups: [group()], harness: { engine: "auto" as const } };
  const runner: StructuredRunnerAdapter = { start(context) {
    seen.push(context.session.selectedModel!);
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve({ ...success(),
      state: { ...success().state, model: context.session.selectedModel! } }) };
  } };
  storage.saveSession({ ...session(), cwd: root, runner: "pi-cli-json", employeeId: "employee-sdk",
    employeeCandidates: [{ provider: "pi", model: "default", thinkingEffort: "off", mode: "managed", kind: "structured", engine: "sdk" }],
    employeeCandidateIndex: 0 });
  const manager = new StructuredSessionManager(storage, config, null, { core: runner });
  try {
    const first = await manager.sendMessage("group-session", "第一轮");
    assert.equal(first.structuredState?.model, "first");
    assert.equal(first.selectedModel, modelGroupSelector(group()));
    const history = structuredClone(first.messages);
    config.modelGroups = [{ ...group(), models: ["second", "first"] }];
    const second = await manager.sendMessage("group-session", "第二轮");
    assert.equal(second.structuredState?.model, "second");
    assert.deepEqual(second.messages?.slice(0, history?.length), history);
    assert.deepEqual(seen, ["first", "second"]);
    assert.equal(storage.loadSessions()[0]!.selectedModel, modelGroupSelector(group()));
    assert.throws(() => manager.setSessionModel("group-session", "wand-model-group/claude/coding"), /不属于/);
  } finally { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("系统运维员工选模型分组，展开为保序的文本候选，其他员工候选不改写", () => {
  const agents = [{ provider: "pi" as const, model: modelGroupSelector(group()), thinkingEffort: "off" as const,
    kind: "structured" as const, mode: "managed" as const }];
  const employee = systemEmployeeDefinition(agents, new Date().toISOString());
  const context = resolveSystemAiContext(session(), { ...defaultConfig(), modelGroups: [group()] }, employee);
  assert.deepEqual(context.cliCandidates?.map((entry) => entry.model), ["first", "second"]);
  assert.deepEqual(employee.agents, agents);
});

test("目录按工具投影单一分组选项，改名与排序改变 revision，不重复持久化目录", () => {
  let groups = SESSION_PROVIDERS.map((provider) => group(provider));
  const catalog = new ModelCatalogService(() => ({ modelGroups: () => groups,
    configuredClaudeModels: [modelGroupSelector(group("claude"))] }));
  const first = catalog.snapshot();
  for (const provider of SESSION_PROVIDERS) {
    const key = provider === "claude" ? "models" : `${provider}Models`;
    const list = (first as unknown as Record<string, Array<{ id: string; label: string }>>)[key]!;
    assert.equal(list.find((model) => model.id === modelGroupSelector(group(provider)))?.label, "编程分组");
    assert.equal(list.filter((model) => model.id === modelGroupSelector(group(provider))).length, 1,
      "默认模型指向分组时不把选择器重复登记成具体模型");
  }
  first.modelGroups![0]!.models.reverse();
  assert.deepEqual(groups[0]!.models, ["first", "second"]);
  groups = groups.map((entry) => ({ ...entry, name: "新名字", models: ["second", "first"] }));
  let event = "";
  catalog.onChanged((change) => { event = change.revision; });
  catalog.publishModelGroups();
  assert.notEqual(event, first.revision);
  assert.equal(catalog.snapshot().piModels.filter((model) => model.id === modelGroupSelector(group())).length, 1);
  const labeled = withConfiguredDefaultModelLabels({ piModels: [{ id: "default", label: "跟随默认" },
    { id: modelGroupSelector(group()), label: "新名字" }] }, { pi: modelGroupSelector(group()) });
  assert.equal(labeled.piModels[0]!.label, "跟随服务端默认（新名字）");
});

test("模型分组设置 API 验证管理员权限、原子校验、跨设备 CAS 与客户端目录", async () => {
  const prior = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-model-group-api-"));
  const config = { ...defaultConfig(), host: "127.0.0.1", port: 0, https: false, password: "test-only-password", startupCommands: [] };
  const handle = await startServer(config, path.join(root, "config.json"), { modelRefreshOptions: () => ({ env: {},
    commandRunner: async () => { throw new Error("offline"); } }) });
  try {
    const base = handle.urls[0]!.url;
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-only-password", client: "browser-extension" }) });
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const { appToken } = await login.json() as { appToken: string };
    const admin = { Cookie: cookie, "Content-Type": "application/json" };
    const connected = { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" };
    const post = (body: unknown, headers = admin) => fetch(`${base}/api/settings/config`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post({ modelGroups: [group()] }, connected)).status, 403);
    const saved = await post({ modelGroups: [group()], expectedModelGroups: [] });
    assert.equal(saved.status, 200);
    assert.deepEqual(config.modelGroups, [group()]);
    assert.equal((await saved.json() as { restartRequired: boolean }).restartRequired, false);
    const changed = { ...group(), models: ["second", "first"] };
    assert.equal((await post({ modelGroups: [changed], expectedModelGroups: [] })).status, 409);
    assert.deepEqual(config.modelGroups, [group()]);
    assert.equal((await post({ modelGroups: [{ ...group(), models: [] }], defaultProvider: "gemini" })).status, 400);
    assert.equal(config.defaultProvider, "claude", "其他偏好也不因无效分组被半保存");
    assert.equal((await post({ modelGroups: [changed], expectedModelGroups: [group()], defaultPiModel: modelGroupSelector(group()) })).status, 200);
    const catalog = await (await fetch(`${base}/api/models`, { headers: connected })).json() as {
      piModels: Array<{ id: string; label: string }>; modelGroups: ModelGroup[] };
    assert.equal(catalog.piModels.find((model) => model.id === modelGroupSelector(group()))?.label, "编程分组");
    assert.deepEqual(catalog.modelGroups.find((entry) => entry.id === "coding")?.models, ["second", "first"]);
    assert.equal((await post({ modelGroups: [], expectedModelGroups: [changed] })).status, 200);
    assert.equal(config.defaultPiModel, modelGroupSelector(group()), "删除分组不偷偷改员工、会话或默认选择");
    assert.throws(() => resolveModelGroupModels(config.modelGroups, "pi", config.defaultPiModel), /已删除/);
  } finally {
    await handle.close(); rmSync(root, { recursive: true, force: true });
    if (prior === undefined) delete process.env.WAND_TEST_MODE; else process.env.WAND_TEST_MODE = prior;
  }
});
