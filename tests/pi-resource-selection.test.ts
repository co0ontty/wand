import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { discoverPiResources, resolvePiResourceSelection } from "../src/pi-resource-catalog.js";
import { preparePiResources } from "../src/pi-resource-run.js";
import { defaultPiCliSessionSettings, patchPiSessionSettings, patchPiResourceSelection } from "../src/pi-session-settings.js";
import { PiRunner } from "../src/structured-pi-adapter.js";
import type { SessionSnapshot } from "../src/types.js";
import { CoreRunner } from "../src/core-runner.js";
import { withAutomaticPiResources } from "../src/pi-auto-resources.js";
import type { DecisionResult } from "../src/decision-types.js";
import { defaultConfig } from "../src/config.js";
import { withModelGroups } from "../src/model-group-runner.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { StructuredRunnerAdapter, StructuredRunnerResult } from "../src/structured-runner.js";

const run = promisify(execFile);

function fixture(t: { after(fn: () => void): void }, autoCleanup = true) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-resource-test-"));
  const agentDir = path.join(root, "agent"); mkdirSync(agentDir);
  for (const name of ["selected-design", "other-installed"]) {
    const dir = path.join(agentDir, "skills", name); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name === "selected-design" ? "SELECTED_INSTRUCTIONS" : "UNSELECTED_SENTINEL"}\n---\n# ${name}\nRead this only for ${name}.\n`);
  }
  if (autoCleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, config: { harness: { engine: "cli" as const, agentDir } } };
}

test("resource selection is strict, bounded and cannot accept paths or commands", () => {
  const selection = { skills: ["skill-" + "a".repeat(24)], mcpServers: [] };
  assert.deepEqual(patchPiResourceSelection(selection), selection);
  for (const raw of [null, [], {}, { skills: [], mcpServers: [], path: "/tmp" },
    { skills: ["../SKILL.md"], mcpServers: [] }, { skills: selection.skills.concat(selection.skills), mcpServers: [] },
    { skills: Array(65).fill(selection.skills[0]), mcpServers: [] }, { skills: [], mcpServers: ["https://example.com/mcp"] }]) {
    assert.throws(() => patchPiResourceSelection(raw));
  }
  assert.deepEqual(defaultPiCliSessionSettings().resources, { skills: [], mcpServers: [] });
  assert.equal(defaultPiCliSessionSettings().globalTools, true, "resource selection must not restrict common tools");
  const before = defaultPiCliSessionSettings();
  const next = patchPiSessionSettings(before, { resources: selection });
  assert.deepEqual(before.resources, { skills: [], mcpServers: [] });
  assert.deepEqual(next.tools, before.tools);
});

test("catalog lists installed skills and configured MCP without connecting or revealing config", async (t) => {
  const { root, agentDir, config } = fixture(t);
  const raw = { mcpServers: { demo: { url: "https://example.invalid/mcp", headers: { Authorization: "Bearer TEST_SENTINEL" } } } };
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(raw));
  const inventory = await discoverPiResources(config, root);
  assert.ok(inventory.catalog.skills.some((item) => item.name === "selected-design"));
  assert.equal(inventory.catalog.mcpServers.length, 1);
  const publicJson = JSON.stringify(inventory.catalog);
  assert.doesNotMatch(publicJson, /TEST_SENTINEL|example\.invalid|Authorization|SKILL\.md/);
  const chosen = inventory.catalog.skills.find((item) => item.name === "selected-design")!;
  const selection = { skills: [chosen.id], mcpServers: [inventory.catalog.mcpServers[0].id] };
  assert.equal(resolvePiResourceSelection(inventory, selection).skills[0].name, "selected-design");
  assert.throws(() => resolvePiResourceSelection(inventory, { ...selection, skills: ["skill-" + "0".repeat(24)] }), /已不存在/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8")), raw);
});

test("unselected malformed MCP does not prevent an explicit no-MCP skill session", async (t) => {
  const { root, agentDir, config } = fixture(t);
  writeFileSync(path.join(agentDir, "mcp.json"), "invalid JSON");
  const inventory = await discoverPiResources(config, root);
  assert.equal(inventory.catalog.supported, true);
  assert.match(inventory.catalog.reason, /无效/);
  assert.equal(inventory.catalog.mcpServers.length, 0);
  assert.deepEqual(resolvePiResourceSelection(inventory, { skills: [], mcpServers: [] }), { skills: [], servers: [] });
});

test("cancelled resource preparation never spawns; missing selection does not fall back", async (t) => {
  const { root, agentDir } = fixture(t);
  let spawns = 0;
  const runner = new PiRunner((() => { spawns++; throw new Error("must not spawn"); }) as any, undefined, agentDir);
  const session = { id: "test", provider: "pi", sessionKind: "structured", cwd: root, selectedModel: null,
    claudeSessionId: null, piSettings: defaultPiCliSessionSettings() } as SessionSnapshot;
  const observer = { isActive: () => true, onUpdate() {} };
  const active = runner.start({ session, prompt: "x", env: {} }, observer);
  active.interrupt();
  assert.match((await active.completion).primaryError ?? "", /取消/);
  const missing = runner.start({ session: { ...session, piSettings: { ...session.piSettings!,
    resources: { skills: ["skill-" + "0".repeat(24)], mcpServers: [] } } }, prompt: "x", env: {} }, observer);
  assert.match((await missing.completion).primaryError ?? "", /不存在/);
  assert.equal(spawns, 0);
});

test("unsupported SDK execution refuses a saved resource selection before any model request", async () => {
  let resolved = false;
  const runner = new CoreRunner({ config: defaultConfig(), modelResolver: async () => {
    resolved = true; throw new Error("must not resolve model");
  } });
  const session = { id: "sdk-resource-boundary", cwd: tmpdir(), provider: "pi", selectedModel: null,
    piSettings: defaultPiCliSessionSettings() } as SessionSnapshot;
  const execution = runner.start({ session, prompt: "x", env: {} }, { isActive: () => true, onUpdate() {} });
  const result = await execution.completion;
  assert.equal(resolved, false);
  assert.equal(result.inputAccepted, false);
  assert.match(result.primaryError ?? "", /尚不支持.*Skills/);
});

test("a resource constraint never retries another model or silently changes an employee's provider", async (t) => {
  const { root, config } = fixture(t, false);
  const storage = new WandStorage(path.join(root, "wand.db"));
  let starts = 0, fallbackStarts = 0;
  let missingCli = false;
  const failure = (): StructuredRunnerResult => ({ state: { blocks: [], result: "", sessionId: null },
    exitCode: 1, signal: null, stderr: "", primaryError: "所选资源无法使用，没有改用其他资源。",
    inputAccepted: false, retryForbidden: true,
    ...(missingCli ? { spawnError: Object.assign(new Error("pi missing"), { code: "ENOENT" }) } : {}),
  });
  const pi: StructuredRunnerAdapter = { start() {
    starts++;
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(failure()) };
  } };
  const wrapped = withModelGroups(pi, { ...defaultConfig(), modelGroups: [{ id: "resources", provider: "pi", name: "资源测试", models: ["first", "second"] }] });
  const target = { id: "group-resource", cwd: root, provider: "pi", selectedModel: "wand-model-group/pi/resources" } as SessionSnapshot;
  await wrapped.start({ session: target, prompt: "x", env: {} }, { isActive: () => true, onUpdate() {} }).completion;
  assert.equal(starts, 1);
  const fallback: StructuredRunnerAdapter = { start() { fallbackStarts++; throw new Error("must not change provider"); } };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), ...config, defaultCwd: root }, null, { pi, claudeCli: fallback });
  t.after(async () => {
    manager.dispose(); await whenIterationPromptsSettled(); storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const source of ["resource error", "missing selected executor"]) {
    missingCli = source !== "resource error";
    const session = manager.createSession({ cwd: root, mode: "managed", provider: "pi", employeeId: "e_test_resources",
      employeeCandidates: [
        { provider: "pi", model: "default", mode: "managed", thinkingEffort: "off", kind: "structured" },
        { provider: "claude", model: "default", mode: "managed", thinkingEffort: "off", kind: "structured" },
      ], employeeCandidateIndex: 0 });
    await assert.rejects(manager.sendMessage(session.id, "验证资源边界"));
    assert.equal(manager.get(session.id)?.provider, "pi");
    assert.equal(manager.get(session.id)?.employeeCandidateIndex, 0);
    assert.equal(fallbackStarts, 0);
  }
});

test("real Pi CLI: selected Skills in model context; only selected MCP connects; common tools remain", {
  timeout: 120_000,
}, async (t) => {
  try { await run("pi", ["--version"], { timeout: 10_000 }); } catch { t.skip("Pi CLI not installed"); return; }
  const { root, agentDir, config } = fixture(t);
  const requests: any[] = [];
  const connections = { selected: 0, unselected: 0 };
  const server = createServer(async (req, res) => {
    let content = ""; for await (const chunk of req) content += chunk;
    const body = content ? JSON.parse(content) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/model")) {
      requests.push(body);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1,
        model: "selection-probe", choices: [{ index: 0, delta: { role: "assistant", content: "selection verified" }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1,
          model: "selection-probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
        + "data: [DONE]\n\n"); return;
    }
    const name = req.url?.includes("unselected") ? "unselected" : "selected";
    connections[name]++;
    if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
    if (!body.id) { res.statusCode = 202; res.end(); return; }
    let result: unknown = {};
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: `${name}-server`, version: "1" } };
    if (body.method === "tools/list") result = { tools: [{ name: "echo", description: `${name}-mcp-tool`,
      inputSchema: { type: "object", properties: {} } }] };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { selectionProbe: {
    baseUrl: `${origin}/model`, api: "openai-completions", apiKey: "SYNTHETIC_TEST_KEY",
    models: [{ id: "selection-probe", name: "Selection probe", contextWindow: 200000, maxTokens: 1000,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const mcpFile = path.join(agentDir, "mcp.json");
  const original = JSON.stringify({ mcpServers: {
    selected: { url: `${origin}/selected`, exposure: "direct" },
    unselected: { url: `${origin}/unselected`, exposure: "direct" },
  } });
  writeFileSync(mcpFile, original);
  mkdirSync(path.join(root, ".pi"));
  writeFileSync(path.join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
    projectServer: { url: `${origin}/unselected`, exposure: "direct" },
  } }));
  const inventory = await discoverPiResources(config, root);
  const skill = inventory.catalog.skills.find((item) => item.name === "selected-design")!;
  const mcp = inventory.catalog.mcpServers.find((item) => item.name === "selected")!;
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  for (const key of Object.keys(env)) {
    if (/^WAND_(KNOWLEDGE|DECISION|PI_RESOURCE)/.test(key) || key === "NODE_TEST_CONTEXT" || key === "NODE_OPTIONS") delete env[key];
  }
  const prepared = await preparePiResources(agentDir, root, { skills: [skill.id], mcpServers: [mcp.id] }, env);
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile("pi", ["--approve", "--no-session", "--mode", "json", "--print", "--model", "selectionProbe/selection-probe",
        "--thinking", "off", ...prepared.args, "Reply selection verified without running tools."], {
        cwd: root, env: prepared.env, timeout: 80_000, maxBuffer: 2 * 1024 * 1024,
      }, (error, out) => error ? reject(error) : resolve(out));
      // Pi reads piped stdin before startup. A spawn with an open unused stdin never reaches the model.
      child.stdin?.end();
    });
  } catch (error) {
    t.diagnostic(`model requests=${requests.length}, MCP selected=${connections.selected}, unselected=${connections.unselected}`);
    throw error;
  } finally { prepared.close(); }
  assert.match(stdout!, /"type":"session"/);
  assert.ok(requests.length, "real CLI must reach the synthetic model");
  const request = JSON.stringify(requests.at(-1));
  assert.match(request, /SELECTED_INSTRUCTIONS/);
  assert.doesNotMatch(request, /UNSELECTED_SENTINEL|frontend-design|pi-goal-writer/);
  const tools = requests.at(-1).tools.map((tool: any) => tool.function.name);
  for (const name of ["read", "bash", "edit", "write", "mcp__selected__echo"]) assert.ok(tools.includes(name), name);
  assert.ok(!tools.some((name: string) => name.includes("unselected")));
  assert.ok(connections.selected > 0);
  assert.equal(connections.unselected, 0, "unselected MCP must never even initialize");
  assert.equal(readFileSync(mcpFile, "utf8"), original);
  assert.equal(existsSync(prepared.env.WAND_PI_RESOURCE_POLICY!), false, "child/parent clean private per-turn files");
  // Explicit empty selection is not a request to load everything. Neither configured MCP connects.
  const countBefore = connections.selected;
  const empty = await preparePiResources(agentDir, root, { skills: [], mcpServers: [] }, env);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("pi", ["--approve", "--no-session", "--mode", "json", "--print", "--model", "selectionProbe/selection-probe",
        "--thinking", "off", ...empty.args, "Reply ok without tools."], { cwd: root, env: empty.env, timeout: 30_000 },
        (error) => error ? reject(error) : resolve());
      child.stdin?.end();
    });
  } finally { empty.close(); }
  const emptyRequest = JSON.stringify(requests.at(-1));
  assert.doesNotMatch(emptyRequest, /SELECTED_INSTRUCTIONS|UNSELECTED_SENTINEL/);
  assert.ok(!requests.at(-1).tools.some((tool: any) => tool.function.name.startsWith("mcp__")));
  assert.equal(connections.selected, countBefore);
  assert.equal(connections.unselected, 0);
  // A per-turn CodeMode override works even when the user config is `only`, and never edits it.
  const settingsFile = path.join(agentDir, "settings.json");
  const userSettings = JSON.stringify({ defaultTools: ["+codemode"], codemode: { mode: "only" } });
  writeFileSync(settingsFile, userSettings);
  for (const mode of ["on", "only", "off", undefined] as const) {
    const scoped = await preparePiResources(agentDir, root, { skills: [skill.id], mcpServers: [mcp.id] }, env, mode);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile("pi", ["--approve", "--no-session", "--mode", "json", "--print", "--model", "selectionProbe/selection-probe",
          "--thinking", "off", ...scoped.args, "Reply without tools."], { cwd: root, env: scoped.env, timeout: 30_000 },
          (error) => error ? reject(error) : resolve());
        child.stdin?.end();
      });
    } finally { scoped.close(); }
    const visible = requests.at(-1).tools.map((tool: any) => tool.function.name);
    if (mode === "only" || mode === undefined) assert.deepEqual(visible, ["codemode"], String(mode));
    else {
      for (const name of ["read", "bash", "edit", "write", "mcp__selected__echo"]) assert.ok(visible.includes(name), `${mode}/${name}`);
      assert.equal(visible.includes("codemode"), mode === "on");
    }
    assert.match(JSON.stringify(requests.at(-1)), /SELECTED_INSTRUCTIONS/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /UNSELECTED_SENTINEL/);
    assert.equal(connections.unselected, 0);
    assert.equal(readFileSync(settingsFile, "utf8"), userSettings);
  }
  for (const enabled of [true, false]) {
    const actualPi = new PiRunner(((file, args, options) => spawn(file, ["--approve", "--no-session", ...(args ?? [])], options)) as typeof spawn, undefined, agentDir);
    const auto = withAutomaticPiResources(actualPi, config, { inventory: async () => inventory,
      evaluate: () => async (raw) => {
        const request = raw as { questions: { forward?: { criteria: { match: string } } } };
        const use = enabled && request.questions.forward?.criteria.match === "Batch tool calls";
        return { model: "fixture", experimental: true, runtime: "laya-mlx", usage: { input_tokens: 20, output_tokens: 0, truncated: false },
          answers: {
            forward: { type: "choice", choice: use ? "match" : "none", probabilities: { match: use ? 1 : 0, none: use ? 0 : 1 } },
            reverse: { type: "choice", choice: use ? "match" : "none", probabilities: { match: use ? 1 : 0, none: use ? 0 : 1 } },
            relevant: { type: "noul", noul: use ? 1 : 0 },
          } } as DecisionResult;
      } });
    const target = { id: `auto-codemode-${enabled}`, provider: "pi", cwd: root, mode: "managed", claudeSessionId: null,
      selectedModel: "selectionProbe/selection-probe", thinkingEffort: "off", piSettings: {
        ...defaultPiCliSessionSettings(), autoResources: true, globalTools: false, tools: ["read"],
        resources: { skills: [skill.id], mcpServers: [] },
      } } as SessionSnapshot;
    const result = await auto.start({ session: target, prompt: "Reply selection verified without running tools.", env },
      { isActive: () => true, onUpdate() {} }).completion;
    assert.equal(result.exitCode, 0, result.primaryError ?? "real Pi CLI must finish");
    const names = requests.at(-1).tools.map((tool: any) => tool.function.name);
    assert.ok(names.includes("read"));
    assert.equal(names.includes("codemode"), enabled, "automatic CodeMode choice must reach the actual model tool list");
    assert.ok(!names.includes("bash"), "automatic CodeMode must not restore a disabled base tool");
    assert.deepEqual(target.piSettings?.resources, { skills: [skill.id], mcpServers: [] });
    assert.equal(target.piSettings?.codemodeOverride, undefined, "automatic override is not a persistent setting");
    assert.equal(result.state.resourceSelection?.codemode?.mode, enabled ? "on" : "off");
    assert.equal(readFileSync(settingsFile, "utf8"), userSettings);
  }
});
