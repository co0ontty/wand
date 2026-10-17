import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { callConfiguredAiText } from "../src/ai-text-runner.js";
import { acquireDeploymentLock, releaseDeploymentLock } from "../src/deployment-lock.js";
import { OpenCodeFreeModelsService, parseOpenCodeFreeModels, registerOpenCodeFreePool, openCodeFreePool, adoptSystemOpenCodeFreeDefault,
  OPENCODE_FREE_REFRESH_MS, type OpenCodeSetupRunner, type OpenCodeFreePool } from "../src/opencode-system-fallback.js";
import { OPENCODE_FREE_GROUP_ID, OPENCODE_FREE_GROUP_SELECTOR } from "../src/opencode-free-selection.js";
import { defaultModelGroupSelector, normalizeModelGroups, preserveOpenCodeFreeMembership, type ModelGroup } from "../src/model-groups.js";
import { resolveSystemAiContext } from "../src/session-ai-context.js";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { ModelCatalogService } from "../src/models.js";

function model(id = "opencode/test-free", changes: Record<string, unknown> = {}): string {
  return `${id}\n${JSON.stringify({ id: id.split("/")[1], providerID: "opencode", status: "active", name: 'Name with { and escaped " quote',
    api: { id: id.split("/")[1], url: "https://opencode.ai/inference/v1", npm: "@ai-sdk/openai-compatible" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { input: { text: true }, output: { text: true }, toolcall: true }, ...changes }, null, 2)}\n`;
}
function fixture(t: test.TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "wand-opencode-system-")), oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { force: true, recursive: true }); }); return root;
}
function storageFixture(t: test.TestContext, root: string): WandStorage {
  const storage = new WandStorage(path.join(root, "wand.db")); t.after(() => storage.close()); return storage;
}
const group = (models: string[]): ModelGroup => ({ id: OPENCODE_FREE_GROUP_ID, provider: "opencode", name: "免费分组", models });

test("free catalog requires native route and explicit zero prices, not a free suffix or display name", () => {
  assert.deepEqual(parseOpenCodeFreeModels(model() + model()), ["opencode/test-free"]);
  for (const changes of [
    { cost: { input: 0, output: 1 } }, { cost: { input: 0, output: 0, cache: { read: 0.01 } } },
    { cost: { input: 0, output: 0, tiers: { large: { input: 1 } } } },
    { cost: { input: "0", output: "0" } }, { cost: { input: 0 } }, { cost: null },
    { providerID: "other" }, { status: "deprecated" }, { api: { id: "paid-model" } },
    { capabilities: { input: { text: true }, output: { text: true }, toolcall: false } },
  ]) assert.deepEqual(parseOpenCodeFreeModels(model("opencode/test-free", changes)), []);
  assert.deepEqual(parseOpenCodeFreeModels(model("opencode/big-pickle")), ["opencode/big-pickle"]);
  assert.deepEqual(parseOpenCodeFreeModels(model("opencode/native-free", { api: { id: "native-free", url: "https://opencode.ai/inference/v1", npm: "@ai-sdk/openai" } })), ["opencode/native-free"]);
  assert.deepEqual(parseOpenCodeFreeModels(model("opencode/paid", { cost: { input: 1, output: 1 } })), []);
  for (const id of ["opencode/default", "opencode/auto", "other/test-free", "opencode/test-free/paid"]) assert.deepEqual(parseOpenCodeFreeModels(model(id)), []);
  assert.deepEqual(parseOpenCodeFreeModels("opencode/test-free\n"), []);
  assert.deepEqual(parseOpenCodeFreeModels(model("opencode/test-free", { api: { id: "test-free", url: "https://other.invalid/v1", npm: "@ai-sdk/openai-compatible" } })), []);
});

test("native endpoint migration keeps zero-price models without trusting lookalike or paid routes", () => {
  for (const url of ["https://opencode.ai/inference/v1", "https://opencode.ai/inference/openai/v1"]) {
    for (const npm of ["@ai-sdk/openai-compatible", "@ai-sdk/openai"]) {
      const api = { id: "test-free", url, npm };
      assert.deepEqual(parseOpenCodeFreeModels(model("opencode/test-free", { api })), ["opencode/test-free"]);
      assert.deepEqual(parseOpenCodeFreeModels(model("opencode/test-free", { api, cost: { input: 0, output: 1 } })), []);
    }
  }
  for (const url of ["https://opencode.ai.evil.invalid/inference/openai/v1", "https://opencode.ai/inference/unknown/v1",
    "http://opencode.ai/inference/openai/v1", "https://opencode.ai/inference/openai/v1?redirect=paid"]) {
    assert.deepEqual(parseOpenCodeFreeModels(model("opencode/test-free", {
      api: { id: "test-free", url, npm: "@ai-sdk/openai-compatible" },
    })), []);
  }
});

test("a saved empty pool recovers after discovery moves to the new native endpoint and probes its members", async t => {
  const root = fixture(t), storage = storageFixture(t, root), probes: string[] = [];
  storage.setConfigValue("opencode-free-models-v1", JSON.stringify({ version: 1, models: [], syncedAt: Date.now() }));
  const service = new OpenCodeFreeModelsService({ configDir: root, storage, find: () => "/opencode",
    run: async (_file, args) => ({ stdout: args[0] === "--version" ? "1.19.2" : model("opencode/test-free", {
      api: { id: "test-free", url: "https://opencode.ai/inference/openai/v1", npm: "@ai-sdk/openai-compatible" },
    }) }),
    probe: async id => { probes.push(id); return true; },
    onModelsChanged: ids => storage.setPreference("pref:modelGroups", [group(ids)]) });
  t.after(() => service.dispose());
  await service.refresh();
  assert.deepEqual(probes, ["opencode/test-free"]);
  assert.deepEqual((await service.candidates()).map(candidate => candidate.model), ["opencode/test-free"]);
  assert.deepEqual(storage.getPreference<ModelGroup[]>("pref:modelGroups", [])[0]!.models, ["opencode/test-free"]);
});

test("saved group keeps only real probe successes; periodic refresh adds new and removes old/failed/paid models", async t => {
  const root = fixture(t), storage = storageFixture(t, root); let body = model("opencode/a-free") + model("opencode/b-free"), now = 1000;
  const probes: string[] = []; let passed = new Set(["opencode/a-free", "opencode/b-free"]);
  const service = new OpenCodeFreeModelsService({ configDir: root, storage, now: () => now, find: () => "/opencode",
    run: async (_file, args, options) => {
      if (args[0] === "--version") return { stdout: "1.19.1" };
      assert.ok(args.includes("--pure") && args.includes("--refresh"));
      assert.equal(options.cwd, service.execution.cwd); return { stdout: body };
    }, probe: async id => { probes.push(id); return passed.has(id); },
    onModelsChanged: ids => storage.setPreference("pref:modelGroups", [group(ids)]) });
  t.after(() => service.dispose());
  await service.refresh(); assert.deepEqual(storage.getPreference<ModelGroup[]>("pref:modelGroups", [])[0]!.models, ["opencode/a-free", "opencode/b-free"]);
  storage.setPreference("pref:modelGroups", [group(["opencode/b-free", "opencode/a-free"])]);
  assert.deepEqual((await service.candidates()).map(c => c.model), ["opencode/b-free", "opencode/a-free"], "saved order takes effect immediately");
  body += model("opencode/c-free"); passed = new Set(["opencode/b-free", "opencode/c-free"]); now += OPENCODE_FREE_REFRESH_MS;
  await service.refresh();
  assert.deepEqual(storage.getPreference<ModelGroup[]>("pref:modelGroups", [])[0]!.models, ["opencode/b-free", "opencode/c-free"]);
  assert.ok(probes.filter(id => id === "opencode/b-free").length === 2, "old members are re-probed, not assumed healthy forever");
  body = model("opencode/c-free", { cost: { input: 1, output: 0 } });
  assert.deepEqual(await service.candidates(), []);
  assert.deepEqual(storage.getPreference<ModelGroup[]>("pref:modelGroups", [])[0]!.models, []);
});

test("proof persists across restart; editable group membership is not a usability proof; failed price lookup fails closed", async t => {
  const root = fixture(t), storage = storageFixture(t, root); let fail = false, probes = 0;
  const opts = { configDir: root, storage, find: () => "/opencode", run: async (_file: string, args: string[]) => {
    if (args[0] === "--version") return { stdout: "1.19.1" };
    if (fail) throw new Error("network failure"); return { stdout: model() };
  }, probe: async () => { probes++; return true; } };
  const first = new OpenCodeFreeModelsService(opts); await first.refresh(); first.dispose();
  const next = new OpenCodeFreeModelsService(opts); t.after(() => next.dispose());
  storage.setPreference("pref:modelGroups", [group(["opencode/forged-free"])]);
  assert.deepEqual((await next.candidates()).map(c => c.model), ["opencode/test-free"]); assert.equal(probes, 1);
  fail = true; await assert.rejects(next.candidates());
  next.dispose(); await assert.rejects(next.candidates(), /停止/);
});

test("a late probe cannot resurrect a newer paid/removed model, and price checks do not renew usability proof", async t => {
  const root = fixture(t), storage = storageFixture(t, root); let body = model(), now = 1000, slow = false, release: (() => void) | undefined;
  const service = new OpenCodeFreeModelsService({ configDir: root, storage, now: () => now, find: () => "/opencode",
    run: async (_file, args) => ({ stdout: args[0] === "--version" ? "1.19.1" : body }),
    probe: async () => { if (slow) await new Promise<void>(done => { release = done; }); return true; },
    onModelsChanged: ids => storage.setPreference("pref:modelGroups", [group(ids)]) });
  t.after(() => service.dispose()); await service.refresh(); slow = true; now = 2000;
  const late = service.refresh(); while (!release) await new Promise(done => setImmediate(done));
  body = model("opencode/test-free", { cost: { input: 1, output: 0 } });
  assert.deepEqual(await service.candidates(), []);
  release(); await late;
  assert.deepEqual(storage.getPreference<ModelGroup[]>("pref:modelGroups", [])[0]!.models, []);
  const proof = JSON.parse(storage.getConfigValue("opencode-free-models-v1")!);
  assert.equal(proof.syncedAt, 1000); assert.deepEqual(proof.models, []);
});

test("anonymous profile excludes user credentials/config; no paid title model, MCP or project configuration", t => {
  const service = new OpenCodeFreeModelsService({ configDir: fixture(t) }); t.after(() => service.dispose());
  const env = service.execution.env({ HOME: "/user", PATH: "/bin", HTTPS_PROXY: "http://proxy", OPENCODE_API_KEY: "secret",
    OPENCODE_CONFIG: "/user/paid.json", OPENCODE_CONFIG_CONTENT: '{"mcp":{"unsafe":{}}}', OPENCODE_CONFIG_DIR: "/user/config" });
  assert.equal(env.OPENCODE_API_KEY, undefined); assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.HOME, "/user"); assert.equal(env.HTTPS_PROXY, "http://proxy");
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  assert.equal(content.agent.title.disable, true); assert.equal(content.compaction.auto, false);
  assert.ok(!env.OPENCODE_CONFIG_CONTENT!.includes("unsafe")); assert.notEqual(env.XDG_DATA_HOME, "/user/.local/share");
});

test("missing CLI installs once in an isolated user prefix; concurrent sync coalesces and existing CLI is not overwritten", async t => {
  const root = fixture(t); let installed = false, installs = 0, versions = 0;
  const run: OpenCodeSetupRunner = async (file, args) => {
    if (args[0] === "install") {
      installs++; await new Promise(done => setTimeout(done, 20)); installed = true;
      assert.equal(file, "/trusted/npm"); assert.deepEqual(args, ["install", "--global=false", "--prefix", path.join(root, "tools", "opencode"), "--no-audit", "--no-fund", "opencode-ai@latest"]);
      return { stdout: "" };
    }
    if (args[0] === "--version") { versions++; return { stdout: "1.19.1" }; } return { stdout: model() };
  };
  const service = new OpenCodeFreeModelsService({ configDir: root, run, probe: async () => true,
    find: name => name === "npm" ? "/trusted/npm" : installed ? "/managed/opencode" : null });
  t.after(() => service.dispose()); await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(installs, 1); assert.equal(versions, 1);
  assert.ok(process.env.PATH!.split(path.delimiter).includes(path.join(root, "tools", "opencode", "node_modules", ".bin")));
  assert.ok(!existsSync(path.join(root, "tools", "opencode.install-lock")));
});

test("failed install cools down, releases lease and does not leak registry errors; legacy installs are preserved", async t => {
  const root = fixture(t); let installs = 0; const logs: string[] = [];
  const service = new OpenCodeFreeModelsService({ configDir: root, find: name => name === "npm" ? "/npm" : null,
    onLog: line => logs.push(line), run: async () => { installs++; throw new Error("registry-token-secret"); } });
  t.after(() => service.dispose());
  await assert.rejects(service.refresh()); await assert.rejects(service.refresh(), /稍后重试/);
  assert.equal(installs, 1); assert.ok(!logs.join("").includes("registry-token-secret"));
  assert.ok(!existsSync(path.join(root, "tools", "opencode.install-lock")));
  const legacy = new OpenCodeFreeModelsService({ configDir: root, find: () => "/legacy/opencode", run: async () => ({ stdout: "0.0.2" }) });
  t.after(() => legacy.dispose()); await assert.rejects(legacy.refresh(), /未覆盖/);
  const lock = acquireDeploymentLock(path.join(root, "tools", "opencode.install-lock"));
  const locked = new OpenCodeFreeModelsService({ configDir: root, find: name => name === "npm" ? "/npm" : null, run: async () => { throw new Error("must not execute"); } });
  t.after(() => { locked.dispose(); releaseDeploymentLock(lock); }); await assert.rejects(locked.refresh(), /锁/);
});

test("dispose invalidates late successful probe results; periodic timer actually re-probes", async t => {
  const root = fixture(t); let release: (() => void) | undefined, published = 0;
  const service = new OpenCodeFreeModelsService({ configDir: root, find: () => "/opencode",
    run: async (_f, args) => ({ stdout: args[0] === "--version" ? "1.19.1" : model() }),
    probe: async () => { await new Promise<void>(done => { release = done; }); return true; }, onModelsChanged: () => { published++; } });
  const pending = service.refresh();
  while (!release) await new Promise(done => setImmediate(done));
  service.dispose(); release(); await assert.rejects(pending); assert.equal(published, 0);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let probes = 0;
  const periodic = new OpenCodeFreeModelsService({ configDir: root, find: () => "/opencode",
    run: async (_f, args) => ({ stdout: args[0] === "--version" ? "1.19.1" : model() }), probe: async () => { probes++; return true; } });
  periodic.start(); await periodic.refresh(); t.mock.timers.tick(OPENCODE_FREE_REFRESH_MS); await periodic.refresh(); periodic.dispose();
  assert.equal(probes, 2);
});

test("managed group uses the normal stable selector; settings only reorder its server-owned membership", () => {
  const catalog = new ModelCatalogService(() => ({ modelGroups: () => [group([])] }));
  try { assert.ok(catalog.snapshot().opencodeModels.some(model => model.id === OPENCODE_FREE_GROUP_SELECTOR)); }
  finally { catalog.dispose(); }
  const saved = group(["opencode/a-free", "opencode/b-free"]);
  assert.equal(defaultModelGroupSelector([saved], "opencode"), undefined, "ordinary OpenCode native defaults are not silently changed");
  assert.equal(defaultModelGroupSelector([saved], "opencode", OPENCODE_FREE_GROUP_SELECTOR), OPENCODE_FREE_GROUP_SELECTOR);
  assert.deepEqual(normalizeModelGroups([saved]), [saved]); assert.deepEqual(normalizeModelGroups([group([])]), [group([])]);
  assert.deepEqual(normalizeModelGroups([group(["opencode/big-pickle"])]), [group(["opencode/big-pickle"])]);
  assert.throws(() => normalizeModelGroups([group(["other/paid"])]));
  assert.deepEqual(preserveOpenCodeFreeMembership([group(["opencode/paid"])], [saved]), [saved], "native syntax never authorizes injecting an unverified model");
  assert.deepEqual(preserveOpenCodeFreeMembership([], [saved]), [saved]);
  assert.deepEqual(preserveOpenCodeFreeMembership([group(["opencode/b-free", "opencode/unverified-free"])], [saved]), [group(["opencode/b-free", "opencode/a-free"])]);
});

const request = { system: "只返回标题，不使用工具。", prompt: "系统连接验证" };
function fakeCli(t: test.TestContext) {
  const root = fixture(t), bin = path.join(root, "bin"), capture = path.join(root, "calls.jsonl"); mkdirSync(bin);
  const oldDisable = process.env.WAND_SHELL_ENV_DISABLE; process.env.WAND_SHELL_ENV_DISABLE = "1";
  t.after(() => { if (oldDisable === undefined) delete process.env.WAND_SHELL_ENV_DISABLE; else process.env.WAND_SHELL_ENV_DISABLE = oldDisable; });
  writeFileSync(path.join(bin, "opencode"), `#!${process.execPath}\nconst fs=require('node:fs'); const m=process.argv[process.argv.indexOf('--model')+1]; fs.appendFileSync(${JSON.stringify(capture)},m+'\\n');
process.stdin.resume(); process.stdin.on('end',()=>{if(m==='primary')console.log(JSON.stringify({type:'error',error:{data:{message:'original upstream 403'}}}));else console.log(JSON.stringify({type:'text',part:{text:'免费分组成功'}}));});\n`, { mode: 0o755 }); process.env.PATH = bin;
  return { root, calls: () => readFileSync(capture, "utf8").trim().split("\n") };
}

test("system employee defaults to saved free group; expands only that slot, no implicit fallback or native default", async t => {
  const { root, calls } = fakeCli(t), storage = storageFixture(t, root); let discovers = 0;
  const pool: OpenCodeFreePool = { execution: { cwd: root, env: base => base }, candidates: async () => {
    discovers++; return [{ provider: "opencode", model: "opencode/test-free" }];
  } };
  const unregister = registerOpenCodeFreePool(storage, pool); t.after(unregister);
  const employee = storage.ensureSystemSiliconEmployee(), config = defaultConfig();
  assert.equal(employee.agents[0]!.model, OPENCODE_FREE_GROUP_SELECTOR);
  const session = { provider: "pi" as const, command: "pi", selectedModel: null, thinkingEffort: "off" as const };
  const ai = resolveSystemAiContext(session, config, employee, undefined, { storage });
  assert.equal(ai.opencodeFree, pool); assert.equal(openCodeFreePool({}), undefined);
  assert.equal(await callConfiguredAiText(request, root, "", ai), "免费分组成功");
  assert.deepEqual(calls(), ["opencode/test-free"]);
  await assert.rejects(callConfiguredAiText(request, root, "", { provider: "opencode", model: "primary" }));
  assert.equal(discovers, 1);
  assert.equal(resolveSystemAiContext(session, config, storage.ensureDecisionExpertEmployee(), undefined, { storage }).opencodeFree, undefined);
  storage.saveSiliconEmployee({ ...employee, agents: [{ ...employee.agents[0]!, provider: "pi", model: "explicit/user-model" }] });
  assert.equal(storage.ensureSystemSiliconEmployee().agents[0]!.model, "explicit/user-model", "restart never overwrites user choices");
});

test("default adoption is atomic and one-time, retains old candidates/profile and refuses to overflow four slots", t => {
  const root = fixture(t), storage = storageFixture(t, root);
  const employee = storage.ensureSystemSiliconEmployee({ cli: "pi", model: "explicit/model" });
  assert.equal(adoptSystemOpenCodeFreeDefault(storage), "adopted");
  const adopted = storage.getSystemSiliconEmployee()!;
  assert.equal(adopted.agents[0]!.model, OPENCODE_FREE_GROUP_SELECTOR);
  assert.deepEqual(adopted.agents.slice(1), employee.agents);
  assert.equal(adopted.prompt, employee.prompt); assert.equal(adopted.createdAt, employee.createdAt);
  storage.saveSiliconEmployee({ ...adopted, agents: employee.agents });
  assert.equal(adoptSystemOpenCodeFreeDefault(storage), "unchanged");
  assert.deepEqual(storage.getSystemSiliconEmployee()!.agents, employee.agents);
  const second = new WandStorage(path.join(root, "full.db"));
  try {
    const full = second.ensureSystemSiliconEmployee({ cli: "pi", model: "1" });
    second.saveSiliconEmployee({ ...full, agents: ["1", "2", "3", "4"].map(model => ({ ...full.agents[0]!, model })) });
    assert.equal(adoptSystemOpenCodeFreeDefault(second), "full");
    assert.equal(second.getSystemSiliconEmployee()!.agents.length, 4);
  } finally { second.close(); }
});

test("empty or failed free group does not use paid defaults; cancellation stops preparation", async t => {
  const { root } = fakeCli(t), execution = { cwd: root, env: (base: NodeJS.ProcessEnv) => base };
  const opts = { cliCandidates: [{ provider: "opencode" as const, model: OPENCODE_FREE_GROUP_SELECTOR }], employeeChannelOnly: true };
  await assert.rejects(callConfiguredAiText(request, root, "", { ...opts, opencodeFree: { execution, candidates: async () => [] } }), /免费分组为空/);
  const controller = new AbortController();
  const pending = callConfiguredAiText(request, root, "", { ...opts, signal: controller.signal,
    opencodeFree: { execution, candidates: async () => new Promise(() => {}) } });
  setTimeout(() => controller.abort(new Error("user-cancel")), 30); await assert.rejects(pending, /user-cancel/);
});
