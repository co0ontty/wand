import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { employeeTextCandidates, prepareEmployeeTextCandidate } from "../src/employee-text.js";
import { callConfiguredAiText } from "../src/git-quick-commit.js";
import { OPENROUTER_FREE_SELECTOR, OPENROUTER_FREE_ROUTING } from "../src/openrouter-free-models.js";
import { resolveSystemAiContext } from "../src/session-ai-context.js";
import type { WandTaskAgent } from "../src/task-types.js";

const sdk: WandTaskAgent = { provider: "pi", engine: "sdk", model: OPENROUTER_FREE_SELECTOR,
  kind: "structured", mode: "default", thinkingEffort: "off" };
const request = { system: "只输出文字，不能执行操作。", prompt: "公开测试内容" };

test("候选计划按配置顺序展开一次、去重且保留 CLI/SDK 身份", () => {
  const config = { ...defaultConfig(), defaultPiModel: "wand-model-group/pi/work",
    modelGroups: [{ id: "work", provider: "pi" as const, name: "工作", models: ["one", "two"] }] };
  const input = [{ ...sdk, model: "default" }, { ...sdk, model: "two" }, { ...sdk, model: "two", engine: "cli" as const }];
  const before = JSON.stringify(input);
  assert.deepEqual(employeeTextCandidates(input, config).map(({ agent, index }) => [index, agent.engine, agent.model]),
    [[0, "sdk", "one"], [0, "sdk", "two"], [2, "cli", "two"]]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(employeeTextCandidates([{ ...sdk, model: "wand-model-group/pi/deleted" }], config), []);
});

test("系统上下文保留分组、执行时展开，不重复替换默认或改写保存配置", () => {
  const config = { ...defaultConfig(), defaultPiModel: "wand-model-group/pi/work",
    modelGroups: [{ id: "work", provider: "pi" as const, name: "工作", models: ["one", "two"] }] };
  const employee = { id: "e", name: "测试", duty: "测试", prompt: "规则", avatar: "", createdAt: "", updatedAt: "",
    agents: [{ ...sdk, model: "default" }] };
  const context = resolveSystemAiContext({ provider: "claude", command: "claude", selectedModel: null,
    thinkingEffort: "off" }, config, employee);
  assert.equal(context.model, "wand-model-group/pi/work");
  assert.equal(context.cliCandidates?.length, 1);
  assert.equal(context.cliCandidates?.[0].model, "wand-model-group/pi/work");
  assert.equal(employee.agents[0].model, "default");
});

test("系统员工混合 SDK/CLI 链真实走对应文本适配，保留原输出校验回退", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-text-adapters-")), bin = join(root, "bin");
  mkdirSync(bin);
  const attempts: string[] = [], payloads: any[] = [];
  let responseText = "SDK 完成", refusal = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); payloads.push(body); attempts.push(body.model);
    if (refusal) { res.writeHead(refusal, { "content-type": "application/json" }); res.end('{"error":{"message":"offline"}}'); return; }
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    res.setHeader("content-type", "text/event-stream");
    res.end(event({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })
      + event({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })
      + "data: [DONE]\n\n");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const model = { id: "offline:free", name: "Offline", provider: "openrouter", api: "openai-completions",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 };
  const config = { ...defaultConfig(), defaultCwd: root };
  const free = { resolveForCall: async () => ({ apiKey: "offline-test", model }) as any };
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("CLI 完成"));\n`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldShell = process.env.WAND_SHELL_ENV_DISABLE;
  process.env.PATH = bin; process.env.WAND_SHELL_ENV_DISABLE = "1";
  t.after(() => { process.env.PATH = oldPath; if (oldShell === undefined) delete process.env.WAND_SHELL_ENV_DISABLE;
    else process.env.WAND_SHELL_ENV_DISABLE = oldShell; rmSync(root, { recursive: true, force: true }); });
  const cli = { provider: "claude" as const, model: "offline-cli" };
  const options = { employeeText: { config, free }, employeeChannelOnly: true,
    cliCandidates: [{ provider: "pi" as const, engine: "sdk" as const, model: OPENROUTER_FREE_SELECTOR }, cli] };
  assert.equal(await callConfiguredAiText(request, root, "", options), "SDK 完成");
  assert.deepEqual(attempts, ["offline:free"]);
  assert.deepEqual(payloads[0].provider, OPENROUTER_FREE_ROUTING);
  assert.ok(!payloads[0].tools?.length);
  assert.ok(payloads[0].messages.some((m: any) => m.role === "system" && m.content.includes(request.system)));
  responseText = "invalid";
  assert.equal(await callConfiguredAiText(request, root, "", options, text => {
    if (text === "invalid") throw new Error("invalid result"); return text;
  }), "CLI 完成");
  refusal = 429;
  assert.equal(await callConfiguredAiText(request, root, "", options), "CLI 完成");
  refusal = 0;
  assert.equal(await callConfiguredAiText(request, root, "", { ...options, cliCandidates: [cli, options.cliCandidates[0]] }), "CLI 完成");
  assert.equal(payloads.length, 3);

  let usage: unknown;
  const generate = await prepareEmployeeTextCandidate({ config, free, onUsage: value => { usage = value; } }, sdk, request, new AbortController().signal);
  assert.equal(await generate(), "invalid");
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 3, model: "openrouter/offline:free" });

  // A custom, explicitly selected SDK model is resolved only from this isolated
  // test agent directory. Its dummy key and endpoint cannot reach a real model.
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "wand-offline-text": {
    api: "openai-completions", apiKey: "offline-test", baseUrl: model.baseUrl,
    models: [{ id: "custom", name: "Offline custom", reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 4096, cost: model.cost }],
  } } }));
  const generic = await prepareEmployeeTextCandidate({ config: { ...config, harness: { engine: "core", agentDir } },
    onUsage: value => { usage = value; } }, { ...sdk, model: "wand-offline-text/custom" }, request, new AbortController().signal);
  assert.equal(await generic(), "invalid");
  assert.equal(payloads.at(-1).model, "custom");
  assert.ok(!payloads.at(-1).tools?.length);
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 3, model: "wand-offline-text/custom" });
  const cancelled = new AbortController();
  const ready = await prepareEmployeeTextCandidate({ config, free }, sdk, request, cancelled.signal);
  const sent = payloads.length; cancelled.abort();
  await assert.rejects(ready(), { name: "AbortError" });
  assert.equal(payloads.length, sent);

});

test("已取消的系统文本链不开始可用性检查或后续 CLI", async () => {
  let checked = 0;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(callConfiguredAiText(request, process.cwd(), "", {
    signal: abort.signal, employeeChannelOnly: true,
    employeeText: { config: defaultConfig(), free: { resolveForCall: async () => { checked++; throw new Error("offline"); } } },
    cliCandidates: [{ provider: "pi", engine: "sdk", model: OPENROUTER_FREE_SELECTOR }, { provider: "claude" }],
  }), { name: "AbortError" });
  assert.equal(checked, 0);
});

test("系统 SDK 可用性检查受链截止限制，不让迟到结果进入调用", async () => {
  let checked = 0;
  await assert.rejects(callConfiguredAiText(request, process.cwd(), "", {
    budgetMs: 20, employeeChannelOnly: true,
    employeeText: { config: defaultConfig(), free: { resolveForCall: async () => { checked++; return new Promise<never>(() => {}); } } },
    cliCandidates: [{ provider: "pi", engine: "sdk", model: OPENROUTER_FREE_SELECTOR }],
  }), (error: any) => error.code === "CLAUDE_TIMEOUT");
  assert.equal(checked, 1);
});

test("OpenCode 纯文本适配只对本次调用禁用工具，保留既有内联模型配置", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-opencode-text-")), bin = join(root, "bin"); mkdirSync(bin);
  const captured = join(root, "capture.json");
  writeFileSync(join(bin, "opencode"), `#!${process.execPath}\nconst fs=require("node:fs"); process.stdin.resume(); process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({args:process.argv.slice(2),permission:process.env.OPENCODE_PERMISSION,config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)})); console.log(JSON.stringify({type:"text",part:{text:"纯文本"}}));});\n`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldShell = process.env.WAND_SHELL_ENV_DISABLE, oldInline = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.PATH = bin; process.env.WAND_SHELL_ENV_DISABLE = "1";
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ marker: "test-only", provider: { offline: { models: { custom: {} } } },
    permission: { bash: "allow" }, agent: { user: { mode: "primary" } } });
  t.after(() => { process.env.PATH = oldPath;
    if (oldShell === undefined) delete process.env.WAND_SHELL_ENV_DISABLE; else process.env.WAND_SHELL_ENV_DISABLE = oldShell;
    if (oldInline === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = oldInline;
    rmSync(root, { recursive: true, force: true }); });
  const original = process.env.OPENCODE_CONFIG_CONTENT;
  assert.equal(await callConfiguredAiText(request, root, "", { provider: "opencode", model: "offline/custom" }), "纯文本");
  const value = JSON.parse(readFileSync(captured, "utf8"));
  assert.equal(value.permission, '"deny"');
  assert.equal(value.config.permission, "deny"); assert.equal(value.config.share, "disabled");
  assert.equal(value.config.marker, "test-only");
  assert.deepEqual(value.config.provider, { offline: { models: { custom: {} } } });
  assert.ok(value.args.includes("--pure"));
  const agent = value.args[value.args.indexOf("--agent") + 1];
  assert.match(agent, /^wand-text-/); assert.equal(value.config.agent[agent].permission, "deny");
  assert.deepEqual(value.config.agent.user, { mode: "primary" });
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, original);
});

test("Gemini 的临时 deny policy 权限为 0600，失败和取消均清理", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-gemini-policy-test-")), bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "policy.json");
  writeFileSync(join(bin, "gemini"), `#!${process.execPath}\nconst fs=require("node:fs"),args=process.argv.slice(2),policy=args[args.indexOf("--admin-policy")+1];fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({policy,mode:fs.statSync(policy).mode&511}));process.stdin.resume();process.stdin.on("end",()=>{if(args.includes("fail"))process.exit(1);else setInterval(()=>{},1000);});\n`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldShell = process.env.WAND_SHELL_ENV_DISABLE;
  process.env.PATH = bin; process.env.WAND_SHELL_ENV_DISABLE = "1";
  t.after(() => { process.env.PATH = oldPath;
    if (oldShell === undefined) delete process.env.WAND_SHELL_ENV_DISABLE; else process.env.WAND_SHELL_ENV_DISABLE = oldShell;
    rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(callConfiguredAiText(request, root, "", { provider: "gemini", model: "fail" }));
  let value = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(value.mode, 0o600); assert.equal(existsSync(value.policy), false);
  rmSync(marker);
  const abort = new AbortController();
  const pending = callConfiguredAiText(request, root, "", { provider: "gemini", signal: abort.signal, budgetMs: 5000 });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(marker), true); value = JSON.parse(readFileSync(marker, "utf8"));
  abort.abort(); await rejection;
  assert.equal(existsSync(value.policy), false);
});
