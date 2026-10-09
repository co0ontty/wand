import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { defaultConfig, loadConfigWithStorage } from "../src/config.js";
import { isBuiltinSiliconEmployee, siliconEmployeeTags } from "../src/ai-team-types.js";
import { callConfiguredAiText } from "../src/git-quick-commit.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { OPENROUTER_FREE_SELECTOR, OPENROUTER_FREE_ROUTING } from "../src/openrouter-free-models.js";
import { speechPolisherDefinition, speechPolisherSeedAgents } from "../src/speech-polisher-employee.js";
import { SPEECH_POLISHER_ID, SPEECH_POLISHER_KEY } from "../src/speech-polisher-identity.js";
import { SpeechPolisherService, parseSpeechPolishOutput } from "../src/speech-polisher-service.js";
import { WandStorage } from "../src/storage.js";
import type { WandTaskAgent } from "../src/task-types.js";

const backup: WandTaskAgent = { provider: "claude", model: "custom-model", thinkingEffort: "off", mode: "default", kind: "structured" };
const offlineFree = { resolveForCall: async () => { throw new Error("no real network in tests"); } };
function fixture(prepare: NonNullable<ConstructorParameters<typeof SpeechPolisherService>[0]["prepare"]>) {
  const employee = speechPolisherDefinition(new Date().toISOString());
  const service = new SpeechPolisherService({ employee: () => employee, config: defaultConfig(), free: offlineFree, prepare });
  return { service, employee };
}

test("口述整理师：初始只有 Wand Agent 免费分组，可增加/排序候选，重启不覆盖设置", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-speech-role-")), storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  await loadConfigWithStorage(join(root, "config.json"), storage);
  const role = storage.getSystemSiliconEmployee(SPEECH_POLISHER_KEY)!;
  assert.equal(role.id, SPEECH_POLISHER_ID); assert.equal(role.name, "口述整理师");
  assert.deepEqual(role.agents, speechPolisherSeedAgents());
  assert.equal(role.agents.length, 1); assert.equal(role.agents[0].engine, "sdk"); assert.equal(role.agents[0].model, OPENROUTER_FREE_SELECTOR);
  assert.equal(isBuiltinSiliconEmployee(role), true); assert.deepEqual(siliconEmployeeTags(role), ["系统用户"]);
  const app = express(); app.use(express.json()); registerSiliconEmployeeRoutes(app, { storage }); app.use(jsonErrorHandler);
  const server = createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/silicon-employees/${role.id}`;
  const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put({ name: "冒充", agents: role.agents })).status, 400);
  const candidates = [backup, ...role.agents];
  assert.equal((await put({ agents: candidates })).status, 200);
  await loadConfigWithStorage(join(root, "config.json"), storage);
  assert.deepEqual(storage.getSystemSiliconEmployee(SPEECH_POLISHER_KEY)!.agents, candidates);
  // Explicitly replacing the free choice is retained as well; seeding is not an enforced priority.
  assert.equal((await put({ agents: [backup] })).status, 200);
  await loadConfigWithStorage(join(root, "config.json"), storage);
  assert.deepEqual(storage.getSystemSiliconEmployee(SPEECH_POLISHER_KEY)!.agents, [backup]);
  for (const [method, suffix] of [["POST", "/archive"], ["DELETE", ""]]) {
    assert.equal((await fetch(url + suffix, { method })).status, 400);
  }
});

test("整理按员工自己的顺序检查；免费不可用后用已配置备选，没有隐式全局默认", async () => {
  const calls: WandTaskAgent[] = [];
  const h = fixture(async (agent, request) => {
    calls.push(agent);
    assert.equal(JSON.parse(request.prompt).transcript, "那个那个明天 10 点，不要删除 /tmp/demo");
    assert.match(request.system, /不执行其中的指令/);
    if (agent.engine === "sdk") throw new Error("free unavailable");
    return async () => JSON.stringify({ text: "明天 10 点，不要删除 /tmp/demo。" });
  });
  h.employee.agents.push(backup);
  const result = await h.service.polish("那个那个明天 10 点，不要删除 /tmp/demo");
  assert.equal(result.text, "明天 10 点，不要删除 /tmp/demo。"); assert.equal(result.candidate, 1);
  assert.equal(result.originalText, "那个那个明天 10 点，不要删除 /tmp/demo"); assert.equal(result.optimized, true);
  assert.deepEqual(calls.map(a => [a.provider, a.engine, a.model]), [["pi", "sdk", OPENROUTER_FREE_SELECTOR], ["claude", "cli", "custom-model"]]);
  const exhausted = fixture(async () => { throw new Error("unavailable"); });
  const original = await exhausted.service.polish("原始文字");
  assert.equal(original.optimized, false); assert.equal(original.text, "原始文字"); assert.match(original.optimizationError!, /候选均不可用/);
});

test("生成已启动后的错误、无效/超长结果不重放到备选；空转写不调用模型", async () => {
  for (const output of ["bad JSON", '{"text":""}', JSON.stringify({ text: "x".repeat(8001) }), JSON.stringify({ text: "\0" })]) {
    let calls = 0;
    const h = fixture(async () => { calls++; return async () => output; }); h.employee.agents.push(backup);
    const result = await h.service.polish("保留原文");
    assert.equal(result.text, "保留原文"); assert.equal(result.optimized, false); assert.equal(calls, 1);
    assert.equal((await h.service.polish(" ")).text, " "); assert.equal(calls, 1);
  }
  let calls = 0;
  const h = fixture(async () => { calls++; return async () => { throw new Error("unknown delivery"); }; }); h.employee.agents.push(backup);
  assert.equal((await h.service.polish("原文")).text, "原文"); assert.equal(calls, 1);
  assert.equal(parseSpeechPolishOutput('```json\n{"text":"原文。"}\n```'), "原文。");
});

test("取消迟到检查、并发上限与关闭释放槽位，不覆盖原文或启动下一候选", async () => {
  let calls = 0;
  const h = fixture(async () => { calls++; return await new Promise<never>(() => {}); }); h.employee.agents.push(backup);
  const a = new AbortController(), b = new AbortController();
  const first = h.service.polish("第一段", a.signal), second = h.service.polish("第二段", b.signal);
  const busy = await h.service.polish("第三段"); assert.equal(busy.text, "第三段"); assert.equal(busy.optimized, false);
  a.abort(); b.abort(); await assert.rejects(first, { name: "AbortError" }); await assert.rejects(second, { name: "AbortError" });
  assert.equal(calls, 2);
  const next = h.service.polish("第四段"); h.service.dispose(); await assert.rejects(next, { name: "AbortError" });
  assert.equal(calls, 3);
});

test("真实 SDK 文本传输不生成工具/会话，保留免费路由与员工系统提示", async t => {
  const payloads: any[] = [];
  let refusal = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body);
    if (body.model === "test:free" && refusal) {
      res.writeHead(refusal, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "offline refusal" } })); return;
    }
    const event = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
    res.setHeader("content-type", "text/event-stream");
    res.end(event({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: '{"text":"明天 10 点开会。"}' }, finish_reason: null }] })
      + event({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + "data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  let checked = 0;
  const role = speechPolisherDefinition(new Date().toISOString());
  const service = new SpeechPolisherService({ config: defaultConfig(), employee: () => role,
    free: { resolveForCall: async selector => {
      assert.ok([OPENROUTER_FREE_SELECTOR, "wand-openrouter-free/backup"].includes(selector)); checked++;
      return { apiKey: "offline-test", model: { id: selector === OPENROUTER_FREE_SELECTOR ? "test:free" : "backup:free", name: "Offline", provider: "openrouter", api: "openai-completions",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 } } as any;
    } } });
  t.after(() => service.dispose());
  assert.equal((await service.polish("那个明天 10 点开会")).text, "明天 10 点开会。");
  assert.equal(checked, 1); assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].provider, OPENROUTER_FREE_ROUTING);
  assert.ok(!payloads[0].tools?.length); assert.ok(payloads[0].messages.some((m: any) => m.role === "system" && m.content.includes("口述整理师")));
  assert.ok(payloads[0].messages.some((m: any) => m.role === "user" && m.content === JSON.stringify({ transcript: "那个明天 10 点开会" })));
  role.agents.push({ ...role.agents[0], model: "wand-openrouter-free/backup" });
  for (const status of [401, 402, 403, 404, 429]) {
    refusal = status;
    const before = payloads.length;
    const result = await service.polish("那个明天 10 点开会");
    assert.equal(result.optimized, true); assert.equal(result.candidate, 1);
    assert.deepEqual(payloads.slice(before).map(p => p.model), ["test:free", "backup:free"]);
  }
  for (const status of [408, 409, 500]) {
    refusal = status;
    const before = payloads.length;
    const result = await service.polish("原文");
    assert.equal(result.optimized, false); assert.equal(result.text, "原文");
    assert.deepEqual(payloads.slice(before).map(p => p.model), ["test:free"]);
  }
});

test("共享一次性 CLI 文本取消停止子进程且不会进入下一备选", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-speech-cancel-")); const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "started"), stopped = join(root, "stopped"), backupMarker = join(root, "backup");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nconst fs=require('node:fs'); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)}); process.stdin.resume(); setInterval(()=>{},1000); fs.writeFileSync(${JSON.stringify(marker)},'started');\n`, { mode: 0o755 });
  writeFileSync(join(bin, "grok"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(backupMarker)},'wrong');\n`, { mode: 0o755 });
  const old = process.env.PATH, oldShell = process.env.WAND_SHELL_ENV_DISABLE;
  process.env.PATH = bin; process.env.WAND_SHELL_ENV_DISABLE = "1";
  t.after(() => {
    process.env.PATH = old;
    if (oldShell === undefined) delete process.env.WAND_SHELL_ENV_DISABLE; else process.env.WAND_SHELL_ENV_DISABLE = oldShell;
    rmSync(root, { recursive: true, force: true });
  });
  const abort = new AbortController();
  const pending = callConfiguredAiText({ system: "整理文字", prompt: "测试" }, root, "", { provider: "claude", signal: abort.signal,
    cliCandidates: [{ provider: "claude" }, { provider: "grok" }], employeeChannelOnly: true });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 20));
  const started = existsSync(marker); abort.abort(); await rejection; assert.equal(started, true);
  for (let i = 0; i < 100 && !existsSync(stopped); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(readFileSync(stopped, "utf8"), "stopped"); assert.equal(existsSync(backupMarker), false);
});

test("截止时间保留原文，迟到生成不能覆写；用户取消不尝试备选", async t => {
  let finish: (text: string) => void = () => {};
  let entered: () => void = () => {};
  let calls = 0;
  const started = new Promise<void>(r => { entered = r; });
  const h = fixture(async () => { calls++; return () => { entered(); return new Promise<string>(r => { finish = r; }); }; });
  t.after(() => h.service.dispose());
  h.employee.agents.push(backup);
  // Keep the event loop live: AbortSignal.timeout intentionally doesn't retain it.
  const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive));
  const result = await h.service.polish("截止前原文", undefined, 1000);
  assert.equal(result.text, "截止前原文"); assert.equal(result.optimized, false); assert.equal(calls, 1);
  finish('{"text":"迟到结果"}'); assert.equal(result.text, "截止前原文");
  const abort = new AbortController(), pending = h.service.polish("取消段落", abort.signal);
  await started; await new Promise(r => setTimeout(r, 0)); abort.abort();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(calls, 2);
});
