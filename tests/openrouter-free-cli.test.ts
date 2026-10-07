import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { OpenRouterFreeModelsService, OPENROUTER_FREE_SELECTOR, OPENROUTER_FREE_PROVIDER,
  OPENROUTER_FREE_ROUTING } from "../src/openrouter-free-models.js";
import { openOpenRouterFreeCliAccess, prepareOpenRouterFreeCli, revokeOpenRouterFreeCliAccess } from "../src/openrouter-free-cli.js";
import { PiRunner } from "../src/structured-pi-adapter.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import { whenIterationPromptsSettled } from "../src/iteration-log.js";
import type { SessionSnapshot } from "../src/types.js";

const run = promisify(execFile);
const secret = "sk-or-v1-offline-cli-secret";
const row = (id = "vendor/agent:free") => ({ id, name: "Free Agent", context_length: 32768,
  pricing: { prompt: "0", completion: "0", request: "0" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools"], top_provider: { max_completion_tokens: 4096 } });
const probe = () => Response.json({ choices: [{ message: { content: "连接成功" }, finish_reason: "stop" }] });

async function fixture(t: { after(fn: () => void | Promise<void>): void }, fetchImpl: typeof fetch = async (url) =>
  String(url).endsWith("/models/user") ? Response.json({ data: [row()] }) : probe()) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-free-cli-test-"));
  const agentDir = path.join(root, "agent"); mkdirSync(agentDir);
  const storage = new WandStorage(path.join(root, "wand.db"));
  storage.setAppSecret("0123456789abcdef".repeat(4));
  const service = new OpenRouterFreeModelsService(storage, fetchImpl);
  await service.saveKey(secret);
  const session = { id: "free-cli-test", provider: "pi", sessionKind: "structured", runner: "pi-cli-json",
    selectedModel: OPENROUTER_FREE_SELECTOR, thinkingEffort: "off", cwd: root, mode: "managed", status: "running",
    startedAt: new Date().toISOString(), endedAt: null, exitCode: null, output: "", command: "pi",
    archived: false, archivedAt: null, claudeSessionId: null, messages: [], queuedMessages: [],
    autoApprovePermissions: false, approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
  } as SessionSnapshot;
  storage.saveSession(session);
  t.after(async () => {
    await whenIterationPromptsSettled(); service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, agentDir, storage, service, session };
}

test("free CLI uses a scoped capability, not Key args/env/files; revocation and Key changes invalidate it", async (t) => {
  const f = await fixture(t);
  const prepared = prepareOpenRouterFreeCli(f, { session: f.session, prompt: "x", env: {} });
  const policyFile = prepared.env.WAND_PI_FREE_POLICY!;
  const token = prepared.env.WAND_PI_FREE_TOKEN!;
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  assert.doesNotMatch(JSON.stringify({ args: prepared.args, env: prepared.env, policy }), /offline-cli-secret/);
  assert.match(token, /^wf_[A-Za-z0-9_-]{43}$/);
  const requests: string[] = [];
  const access = openOpenRouterFreeCliAccess(policy.databasePath, token, async (url) => {
    requests.push(String(url)); return String(url).endsWith("/models/user") ? Response.json({ data: [row()] }) : probe();
  });
  assert.equal(access.selector, OPENROUTER_FREE_SELECTOR);
  assert.equal((await access.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).apiKey, secret);
  assert.equal(requests.length, 1, "restore verified cache, but always fetch fresh prices");
  f.storage.saveConnector("openrouter", { token: "changed-key" });
  assert.throws(() => access.assertCurrent(), /Key 已变化/);
  access.close(); prepared.close();
  assert.equal(existsSync(policyFile), false);
  assert.throws(() => openOpenRouterFreeCliAccess(policy.databasePath, token), /已失效/);
  assert.throws(() => openOpenRouterFreeCliAccess(policy.databasePath, "wrong"), /授权无效/);
});

test("free CLI scope survives owner reconnection, is session-bound, expires and revokes from child shutdown", async (t) => {
  const f = await fixture(t);
  const prepared = prepareOpenRouterFreeCli(f, { session: f.session, prompt: "x", env: {} });
  const token = prepared.env.WAND_PI_FREE_TOKEN!;
  const reopened = new WandStorage(f.storage.databasePath());
  reopened.close();
  const access = openOpenRouterFreeCliAccess(f.storage.databasePath(), token);
  access.assertCurrent();
  f.storage.saveSession({ ...f.session, status: "idle" });
  assert.throws(() => access.assertCurrent(), /授权已失效/);
  access.close();
  f.storage.saveSession(f.session);
  revokeOpenRouterFreeCliAccess(f.storage.databasePath(), token);
  assert.throws(() => openOpenRouterFreeCliAccess(f.storage.databasePath(), token), /已失效/);
  const expired = f.storage.issueOpenRouterFreeAccess(f.session.id, OPENROUTER_FREE_SELECTOR,
    createHash("sha256").update(secret).digest("hex"), {}, 1);
  assert.throws(() => openOpenRouterFreeCliAccess(f.storage.databasePath(), expired), /已失效/);
  assert.throws(() => f.storage.issueOpenRouterFreeAccess("missing", OPENROUTER_FREE_SELECTOR,
    createHash("sha256").update(secret).digest("hex"), {}), /所属会话/);
  prepared.close();
});

test("free CLI freshly rejects paid models and respects custom group membership without shared cache writes", async (t) => {
  let paid = false;
  const fetchImpl: typeof fetch = async (url) => String(url).endsWith("/models/user")
    ? Response.json({ data: [paid ? { ...row(), pricing: { prompt: "0", completion: "0.01" } } : row(), row("other")] }) : probe();
  const f = await fixture(t, fetchImpl);
  const cache = f.storage.getConfigValue("openrouter-free-models-v1");
  const prepared = prepareOpenRouterFreeCli(f, { session: f.session, prompt: "x", env: {},
    modelGroupModels: [`${OPENROUTER_FREE_PROVIDER}/vendor/agent:free`] });
  const access = openOpenRouterFreeCliAccess(f.storage.databasePath(), prepared.env.WAND_PI_FREE_TOKEN!, fetchImpl);
  paid = true;
  await assert.rejects(access.service.resolveForCall(OPENROUTER_FREE_SELECTOR, undefined, access.requirements), /没有已验证且免费的模型/);
  assert.equal(f.storage.getConfigValue("openrouter-free-models-v1"), cache);
  access.close(); prepared.close();
});

test("free CLI without its bridge never spawns or retries a paid employee candidate", async (t) => {
  const f = await fixture(t);
  let spawns = 0;
  const runner = new PiRunner((() => { spawns++; throw new Error("must not spawn"); }) as any);
  const result = await runner.start({ session: f.session, prompt: "x", env: {} },
    { isActive: () => true, onUpdate() {} }).completion;
  assert.equal(spawns, 0);
  assert.equal(result.inputAccepted, false);
  assert.equal(result.retryForbidden, true);
  assert.match(result.primaryError ?? "", /CLI 接入未就绪/);
});

for (const variant of ["source", "dist"]) test(`real installed Pi CLI (${variant}): free pool, tool continuation, resume and zero-price requests`, {
  timeout: 120_000,
}, async (t) => {
  try { await run("pi", ["--version"], { timeout: 10_000 }); } catch { t.skip("Pi CLI not installed"); return; }
  const distManager = new URL("../dist/structured-session-manager.js", import.meta.url);
  if (variant === "dist" && !existsSync(distManager)) { t.skip("Run npm run build for compiled extension coverage"); return; }
  const Manager = variant === "dist" ? (await import(distManager.href)).StructuredSessionManager : StructuredSessionManager;
  const requests: Array<Record<string, any>> = [];
  let first = true;
  let paid = false;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url === "/models/user") {
      requests.push({ route: "prices" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [paid ? { ...row(), pricing: { prompt: "1", completion: "1" } } : row()] })); return;
    }
    if (req.url !== "/chat/completions") { res.statusCode = 404; res.end(); return; }
    const body = JSON.parse(raw);
    if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{
      message: { content: "连接成功" }, finish_reason: "stop" }] })); return; }
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    requests.push(body);
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "sample.txt" }) } }] }
      : { role: "assistant", content: "免费模型 CLI 成功" };
    const reason = first ? "tool_calls" : "stop"; first = false;
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    res.setHeader("Content-Type", "text/event-stream");
    res.end(event({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }] }) + event({ id: "fixture", object: "chat.completion.chunk",
      created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: reason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const offlineFetch: typeof fetch = (url, options) => fetch(base + new URL(String(url)).pathname.replace("/api/v1", ""), options);
  const f = await fixture(t, offlineFetch);
  writeFileSync(path.join(f.root, "sample.txt"), "FREE_TOOL_RESULT");
  const intercept = path.join(f.agentDir, "offline.ts");
  writeFileSync(intercept, `export default function () {
    const original = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      const value = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (!value.startsWith('https://openrouter.ai/api/v1/')) throw new Error('Unexpected network in free CLI test');
      return original(${JSON.stringify(base)} + new URL(value).pathname.replace('/api/v1', ''), init);
    };
  }`);
  writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [intercept], retry: { enabled: false } }));
  const authFile = path.join(f.agentDir, "auth.json");
  const modelsFile = path.join(f.agentDir, "models.json");
  writeFileSync(authFile, "{}"); writeFileSync(modelsFile, '{"providers":{}}');
  const before = [readFileSync(authFile, "utf8"), readFileSync(modelsFile, "utf8")];
  const manager = new Manager(f.storage, { ...defaultConfig(), defaultCwd: f.root,
    defaultPiModel: OPENROUTER_FREE_SELECTOR, harness: { engine: "cli", agentDir: f.agentDir } },
  null, {}, undefined, () => null, f.service);
  t.after(() => manager.dispose());
  const session = manager.createSession({ cwd: f.root, provider: "pi", mode: "managed", model: OPENROUTER_FREE_SELECTOR,
    thinkingEffort: "off", title: "Offline free CLI check" });
  // Short prompts avoid unrelated system-title inference; the fixture deterministically asks Read.
  const result = await manager.sendMessage(session.id, "读文件");
  assert.equal(result.structuredState?.engine, "cli");
  assert.equal(result.selectedModel, OPENROUTER_FREE_SELECTOR);
  assert.equal(result.structuredState?.model, "vendor/agent:free");
  assert.match(result.output, /免费模型 CLI 成功/);
  assert.ok(result.messages?.some((turn) => turn.content.some((block) => block.type === "tool_result")));
  assert.ok(result.claudeSessionId, "a native Pi session exists for resume");
  const resumed = await manager.sendMessage(session.id, "继续确认");
  assert.equal(resumed.claudeSessionId, result.claudeSessionId);
  const calls = requests.filter((request) => request.stream);
  assert.equal(calls.length, 3);
  for (const call of calls) { assert.deepEqual(call.provider, OPENROUTER_FREE_ROUTING); assert.equal(call.model, "vendor/agent:free"); }
  assert.ok(calls[1].messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("FREE_TOOL_RESULT")));
  assert.ok(requests.filter((request) => request.route === "prices").length >= 3);
  paid = true;
  await assert.rejects(manager.sendMessage(session.id, "不允许收费"), /没有已验证且免费的模型/);
  assert.equal(requests.filter((request) => request.stream).length, 3, "repricing prevents all further inference");
  assert.deepEqual([readFileSync(authFile, "utf8"), readFileSync(modelsFile, "utf8")], before);
});
