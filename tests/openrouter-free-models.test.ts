import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { ModelCatalogService } from "../src/models.js";
import { OpenRouterFreeModelsService, OPENROUTER_FREE_PROVIDER, OPENROUTER_FREE_SELECTOR, OPENROUTER_REFRESH_MS,
  parseOpenRouterFreeModels } from "../src/openrouter-free-models.js";
import { WandStorage } from "../src/storage.js";
import { startServer } from "../src/server.js";

const freeRow = (id = "vendor/agent:free") => ({
  id, name: "Free Agent", pricing: { prompt: "0", completion: "0", request: "0" },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  context_length: 32768, top_provider: { max_completion_tokens: 4096 },
  supported_parameters: ["tools", "reasoning"],
});
const selector = `${OPENROUTER_FREE_PROVIDER}/vendor/agent:free`;
const secret = "sk-or-v1-offline-test-secret";
const successfulProbe = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "免费模型连接验证" } }] });
function mockOpenRouter(discovery: typeof fetch): typeof fetch {
  return async (url, options) => String(url).endsWith("/chat/completions")
    ? successfulProbe() : discovery(url, options);
}
function setup(fetchImpl: typeof fetch, now?: () => Date, handlesProbes = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-openrouter-service-test-"));
  const storage = new WandStorage(path.join(dir, "wand.db"));
  storage.setAppSecret("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const service = new OpenRouterFreeModelsService(storage, handlesProbes ? fetchImpl : mockOpenRouter(fetchImpl), now);
  return { storage, service, dir, close: () => { service.dispose(); storage.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("免费目录只保留零价、文本输出、支持工具的模型，并保留真实上下文容量", () => {
  const free = freeRow();
  const parsed = parseOpenRouterFreeModels({ data: [free, free,
    { ...free, id: "paid", pricing: { prompt: "0", completion: "0.01" } },
    { ...free, id: "request-charge", pricing: { prompt: "0", completion: "0", request: "0.01" } },
    { ...free, id: "unknown-price", pricing: { prompt: "", completion: "0" } },
    { ...free, id: "no-tools", supported_parameters: [] },
    { ...free, id: "image-only", architecture: { output_modalities: ["image"] } },
    { ...free, id: "bad-context", context_length: null },
  ] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.contextWindow, 32768);
  assert.equal(parsed[0]!.maxTokens, 4096);
  assert.equal(parsed[0]!.provider, OPENROUTER_FREE_PROVIDER);
  assert.deepEqual(parsed[0]!.input, ["text", "image"]);
  assert.throws(() => parseOpenRouterFreeModels({ error: "failure" }), /格式无效/);
});

test("保存 Key 后认证获取目录；凭据加密、状态不回显，重启恢复可执行模型", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/models/user");
    assert.equal((options!.headers as Record<string, string>).Authorization, `Bearer ${secret}`);
    assert.equal(options!.redirect, "error");
    return Response.json({ data: [{ ...freeRow(), private_echo: secret }] });
  };
  const fixture = setup(fetchImpl);
  try {
    const result = await fixture.service.saveKey(secret);
    assert.equal(result.configured, true);
    assert.equal(result.modelCount, 1);
    assert.equal(result.lastError, null);
    assert.equal(calls, 1);
    assert.equal(fixture.service.catalog()[0]!.id, OPENROUTER_FREE_SELECTOR);
    assert.equal(fixture.service.catalog()[0]!.label, "免费分组");
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "vendor/agent:free");
    assert.equal(fixture.service.resolve(selector)?.apiKey, secret);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(fixture.storage.getConfigValue("openrouter-free-models-v1")!.includes(secret), false);
    assert.equal(readFileSync(path.join(fixture.dir, "wand.db")).includes(Buffer.from(secret)), false);
    const restored = new OpenRouterFreeModelsService(fixture.storage, fetchImpl);
    assert.equal(restored.resolve(selector)?.model.id, "vendor/agent:free");
    assert.equal(restored.status().modelCount, 1);
    restored.dispose();
  } finally { fixture.close(); }
});

test("免费分组是单一可选项，自动按思考需求和上下文分配，旧具体模型仍可执行", async () => {
  const rows = [
    { ...freeRow("small"), context_length: 4096 },
    { ...freeRow("large"), context_length: 131072, supported_parameters: ["tools"] },
    { ...freeRow("reasoning"), context_length: 65536 },
  ];
  const fixture = setup(async () => Response.json({ data: rows }));
  try {
    const status = await fixture.service.saveKey(secret);
    assert.equal(status.modelCount, 3, "状态统计池中真实模型数量，不是下拉项数量");
    assert.deepEqual(fixture.service.catalog(), [{ id: OPENROUTER_FREE_SELECTOR, label: "免费分组",
      reasoningEfforts: ["off", "minimal", "low", "medium", "high"].map(effort => ({ effort })) }]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "large");
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).model.id, "large");
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR, { preferReasoning: true })?.model.id, "reasoning");
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR, undefined,
      { preferReasoning: true })).model.id, "reasoning");
    assert.equal(fixture.service.resolve(`${OPENROUTER_FREE_PROVIDER}/small`)?.model.id, "small",
      "不覆盖历史会话或显式模型配置");
    const restored = new OpenRouterFreeModelsService(fixture.storage);
    try {
      assert.equal(restored.catalog()[0]!.label, "免费分组");
      assert.equal(restored.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "large");
    } finally { restored.dispose(); }
    fixture.service.clearKey();
    assert.deepEqual(fixture.service.catalog(), []);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR), null);
    await assert.rejects(fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR), /Key 未配置/);
  } finally { fixture.close(); }
});

test("免费分组自动排除收费及验证失败模型，池变化不改变选择值；空池停止调用", async () => {
  let phase = "initial";
  let probes = 0;
  const fixture = setup(async (url, options) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: phase === "empty" ? [] : [
      { ...freeRow("preferred"), context_length: 131072,
        ...(phase === "paid" ? { pricing: { prompt: "0.01", completion: "0" } } : {}) },
      freeRow("replacement"), { ...freeRow("unusable"), context_length: 262144 },
    ] });
    probes++;
    return JSON.parse(String(options!.body)).model === "unusable"
      ? Response.json({}, { status: 429 }) : successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).model.id, "preferred");
    const catalog = fixture.service.catalog();
    phase = "paid";
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).model.id, "replacement");
    assert.deepEqual(fixture.service.catalog(), catalog, "后端成员变化不使客户端已选分组失效");
    assert.equal(fixture.service.status().modelCount, 1);
    assert.equal(probes, 3, "只使用已通过测试的模型，不为可用替补重复探测");
    phase = "empty";
    await assert.rejects(fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR), /没有已验证且免费的模型/);
    assert.deepEqual(fixture.service.catalog(), []);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR), null);
  } finally { fixture.close(); }
});

test("免费分组遵守用户顺序，价格变化跳过首选；自定义分组不越界替补", async () => {
  let paid = false;
  const fixture = setup(async () => Response.json({ data: [
    { ...freeRow("small"), context_length: 4096,
      ...(paid ? { pricing: { prompt: "0.01", completion: "0" } } : {}) },
    { ...freeRow("large"), context_length: 131072 },
  ] }));
  try {
    await fixture.service.saveKey(secret);
    fixture.storage.setPreference("pref:modelGroups", [{ id: "openrouter-free", provider: "pi", name: "免费分组",
      models: [`${OPENROUTER_FREE_PROVIDER}/small`, `${OPENROUTER_FREE_PROVIDER}/large`] }]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR, { preferReasoning: true })?.model.id, "small");
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).model.id, "small");
    assert.deepEqual(fixture.service.members().map((entry) => entry.id),
      [`${OPENROUTER_FREE_PROVIDER}/small`, `${OPENROUTER_FREE_PROVIDER}/large`]);
    const catalog = new ModelCatalogService(() => ({ storage: fixture.storage,
      managedPiModels: () => fixture.service.catalog(), managedPiModelMembers: () => fixture.service.members() }));
    let notifications = 0;
    catalog.onChanged(() => { notifications++; });
    fixture.service.onChanged(() => catalog.publishManagedPiModels());
    const revision = catalog.snapshot().revision;
    paid = true;
    assert.equal((await fixture.service.resolveForCall(OPENROUTER_FREE_SELECTOR)).model.id, "large");
    assert.notEqual(catalog.snapshot().revision, revision);
    assert.equal(notifications, 1, "池选择器没变，但组内成员变动也通知客户端");
    await assert.rejects(fixture.service.resolveForCall(`${OPENROUTER_FREE_PROVIDER}/small`, undefined,
      { allowedSelectors: [`${OPENROUTER_FREE_PROVIDER}/small`] }), /没有已验证且免费的模型/);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "large", "自定义组失败不清空其他可用池成员");
  } finally { fixture.close(); }
});

test("同步失败保留目录，不泄漏提供方错误；成功空目录移除已下架模型", async () => {
  let mode = "success";
  const fixture = setup(async () => {
    if (mode === "network") throw new Error(`OpenRouter leaked ${secret}`);
    if (mode === "invalid") return Response.json({ error: secret }, { status: 401 });
    if (mode === "malformed") return Response.json({ error: secret });
    return Response.json({ data: mode === "empty" ? [] : [freeRow()] });
  });
  try {
    await fixture.service.saveKey(secret);
    for (mode of ["network", "invalid", "malformed"]) {
      const result = await fixture.service.refresh();
      assert.equal(result.modelCount, 1);
      assert.ok(result.lastError);
      assert.equal(result.lastError.includes(secret), false);
    }
    mode = "empty";
    assert.equal((await fixture.service.refresh()).modelCount, 0);
    assert.equal(fixture.service.resolve(selector), null);
  } finally { fixture.close(); }
});

test("并发同步共享请求；移除 Key 后迟到响应不能恢复目录或读取关闭的数据库", async () => {
  let release!: (value: Response) => void;
  let calls = 0;
  const fixture = setup(async () => { calls++; return new Promise<Response>((resolve) => { release = resolve; }); });
  const pending = fixture.service.saveKey(secret);
  const shared = fixture.service.refresh();
  assert.equal(calls, 1);
  fixture.service.clearKey();
  assert.equal(fixture.service.status().modelCount, 0);
  release(Response.json({ data: [freeRow()] }));
  await Promise.all([pending, shared]);
  assert.equal(fixture.service.status().configured, false);
  assert.equal(fixture.service.resolve(selector), null);
  assert.equal(fixture.storage.getConfigValue("openrouter-free-models-v1"), "{}");
  fixture.close();
  assert.equal((await fixture.service.refresh()).configured, false);
});

test("替换 Key 时旧请求不会覆盖新 Key 的目录", async () => {
  let oldRelease!: (value: Response) => void;
  const fixture = setup(async (_url, options) => {
    const auth = (options!.headers as Record<string, string>).Authorization;
    if (auth === "Bearer old-key") return new Promise<Response>((resolve) => { oldRelease = resolve; });
    return Response.json({ data: [freeRow("vendor/new:free")] });
  });
  try {
    const old = fixture.service.saveKey("old-key");
    await fixture.service.saveKey("new-key");
    oldRelease(Response.json({ data: [freeRow()] }));
    await old;
    assert.equal(fixture.service.catalog()[0]!.id, OPENROUTER_FREE_SELECTOR);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "vendor/new:free");
    assert.equal(fixture.service.resolve(selector), null);
  } finally { fixture.close(); }
});

test("服务定时同步在六小时后执行，关闭后停止", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const fixture = setup(async () => { calls++; return Response.json({ data: [freeRow()] }); });
  try {
    await fixture.service.saveKey(secret);
    fixture.service.start();
    await fixture.service.refresh();
    assert.equal(calls, 2);
    t.mock.timers.tick(OPENROUTER_REFRESH_MS);
    await fixture.service.refresh();
    assert.equal(calls, 3);
    fixture.service.dispose();
    t.mock.timers.tick(OPENROUTER_REFRESH_MS);
    assert.equal(calls, 3);
  } finally { fixture.close(); }
});

test("免费分组变化发布到模型目录；CLI 探测不会回写旧免费模型", async () => {
  const fixture = setup(async () => Response.json({ data: [freeRow()] }));
  try {
    const catalog = new ModelCatalogService(() => ({ storage: fixture.storage,
      env: {}, commandRunner: async () => { throw new Error("offline"); },
      managedPiModels: () => fixture.service.catalog(),
    }));
    let changes = 0;
    fixture.service.onChanged(() => catalog.publishManagedPiModels());
    catalog.onChanged(() => { changes++; });
    await fixture.service.saveKey(secret);
    assert.equal(catalog.snapshot().piModels.find((model) => model.id === OPENROUTER_FREE_SELECTOR)?.label, "免费分组");
    assert.equal(catalog.snapshot().piModels.some((model) => model.id === selector), false);
    fixture.service.clearKey();
    assert.equal(catalog.snapshot().piModels.some((model) => model.id === OPENROUTER_FREE_SELECTOR), false);
    await catalog.refresh();
    assert.equal(catalog.snapshot().piModels.some((model) => model.id === OPENROUTER_FREE_SELECTOR), false);
    assert.ok(changes >= 2);
  } finally { fixture.close(); }
});

test("设置接口仅管理员可管理 Key，普通客户端读到免费模型且所有状态不含密钥", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-openrouter-api-test-"));
  const handle = await startServer({ ...defaultConfig(), port: 0, https: false,
    password: "test-password", startupCommands: [], harness: { ...defaultConfig().harness!, engine: "cli" },
  }, path.join(dir, "config.json"), {
    openRouterFetch: mockOpenRouter(async () => Response.json({ data: [freeRow()] })),
    modelRefreshOptions: () => ({ env: {}, commandRunner: async () => { throw new Error("offline"); } }),
  });
  try {
    const base = handle.urls[0]!.url;
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }) });
    const cookie = login.headers.get("set-cookie")!.match(/wand_session_local=([^;]+)/)![0];
    const appLogin = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password", client: "browser-extension" }) });
    const { appToken } = await appLogin.json() as { appToken: string };
    const appHeaders = { Authorization: `Bearer ${appToken}` };
    for (const method of ["GET", "POST", "DELETE"]) {
      assert.equal((await fetch(`${base}/api/settings/openrouter`, { method, headers: appHeaders })).status, 403);
    }
    const adminHeaders = { Cookie: cookie, "Content-Type": "application/json" };
    const saved = await fetch(`${base}/api/settings/openrouter`, { method: "POST", headers: adminHeaders,
      body: JSON.stringify({ apiKey: secret }) });
    assert.equal(saved.status, 200);
    const savedText = await saved.text();
    assert.equal(savedText.includes(secret), false);
    assert.equal(JSON.parse(savedText).modelCount, 1);
    const catalog = await (await fetch(`${base}/api/models`, { headers: appHeaders })).json() as { piModels: Array<{ id: string; label: string }> };
    assert.deepEqual(catalog.piModels.filter((model) => model.id.startsWith(`${OPENROUTER_FREE_PROVIDER}/`))
      .map((model) => ({ id: model.id, label: model.label })), [{ id: OPENROUTER_FREE_SELECTOR, label: "免费分组" }]);
    const settings = await (await fetch(`${base}/api/settings`, { headers: adminHeaders })).text();
    assert.equal(settings.includes(secret), false);
    const removed = await fetch(`${base}/api/settings/openrouter`, { method: "DELETE", headers: adminHeaders });
    assert.equal((await removed.json() as { configured: boolean }).configured, false);
  } finally { await handle.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("每个候选必须真实回复，限流/异常/空回复/未完成/工具调用均剔除且不会被 core 解析", async () => {
  const ids = ["ok", "rate-limit", "network", "empty", "truncated", "tool", "provider-error", "invalid-json", "refused", "oversized"];
  const probed: string[] = [];
  const fixture = setup(async (url, options) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: ids.map(freeRow) });
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(options!.method, "POST");
    assert.equal(new Headers(options!.headers).get("authorization"), `Bearer ${secret}`);
    assert.equal(options!.redirect, "error");
    const payload = JSON.parse(String(options!.body));
    probed.push(payload.model);
    assert.deepEqual(payload.provider, { require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    assert.equal(payload.stream, false);
    assert.ok(payload.max_tokens <= 512);
    assert.equal(payload.tools[0].function.name, "connectivity_check");
    assert.equal(JSON.stringify(payload.messages).includes(secret), false);
    switch (payload.model) {
      case "rate-limit": return Response.json({ error: secret }, { status: 429 });
      case "network": throw new Error(secret);
      case "empty": return Response.json({ choices: [{ finish_reason: "stop", message: { content: "  " } }] });
      case "truncated": return Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] });
      case "tool": return Response.json({ choices: [{ finish_reason: "stop", message: { content: "title", tool_calls: [{}] } }] });
      case "provider-error": return Response.json({ error: secret, choices: [{ finish_reason: "stop", message: { content: "title" } }] });
      case "invalid-json": return new Response("not json");
      case "refused": return Response.json({ choices: [{ finish_reason: "stop", message: { content: "拒绝", refusal: "refused" } }] });
      case "oversized": return new Response("x".repeat(65537));
      default: return successfulProbe();
    }
  }, undefined, true);
  try {
    const status = await fixture.service.saveKey(secret);
    assert.equal(status.candidateCount, ids.length);
    assert.equal(status.modelCount, 1);
    assert.equal(status.rejectedCount, ids.length - 1);
    assert.equal(status.lastError, null);
    assert.deepEqual(probed.sort(), [...ids].sort());
    assert.deepEqual(fixture.service.catalog().map(model => model.id), [OPENROUTER_FREE_SELECTOR]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "ok");
    assert.equal(fixture.service.resolve(`${OPENROUTER_FREE_PROVIDER}/rate-limit`), null);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(fixture.storage.getConfigValue("openrouter-free-models-v1")!.includes("rate-limit"), false);
  } finally { fixture.close(); }
});

test("持续免费的已验证模型复用探测；移除后重新发现需再测试，失败不能重新加入", async () => {
  let listed = true;
  let passing = true;
  let probes = 0;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: listed ? [freeRow()] : [] });
    probes++;
    return passing ? successfulProbe() : Response.json({}, { status: 503 });
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    assert.equal(fixture.service.catalog().length, 1);
    passing = false;
    assert.equal((await fixture.service.refresh()).modelCount, 1);
    assert.equal(probes, 1, "持续免费无需重复探测");
    listed = false;
    assert.equal((await fixture.service.refresh()).modelCount, 0);
    listed = true;
    const failed = await fixture.service.refresh();
    assert.equal(failed.modelCount, 0);
    assert.equal(failed.rejectedCount, 1);
    passing = true;
    assert.equal((await fixture.service.refresh()).modelCount, 1);
    assert.equal(probes, 3);
  } finally { fixture.close(); }
});

test("旧未探测缓存不能直接进入免费分组，Key 替换失败不能沿用旧 Key 的验证结果", async () => {
  const fixture = setup(async () => Response.json({ data: [freeRow()] }));
  try {
    await fixture.service.saveKey(secret);
    const cache = JSON.parse(fixture.storage.getConfigValue("openrouter-free-models-v1")!);
    delete cache.probeVersion;
    fixture.storage.setConfigValue("openrouter-free-models-v1", JSON.stringify(cache));
    const restored = new OpenRouterFreeModelsService(fixture.storage, mockOpenRouter(async () => Response.json({}, { status: 401 })));
    assert.equal(restored.catalog().length, 0);
    assert.equal(restored.resolve(selector), null);
    restored.dispose();
    const failed = new OpenRouterFreeModelsService(fixture.storage, async () => Response.json({}, { status: 401 }));
    await failed.saveKey("replacement-key");
    assert.equal(failed.status().configured, true);
    assert.equal(failed.catalog().length, 0);
    assert.equal(failed.resolve(selector), null);
    failed.dispose();
  } finally { fixture.close(); }
});

test("探测最多两个并发，完成前不发布；清除 Key 会中止探测及后续请求", async () => {
  const releases: Array<() => void> = [];
  let requests = 0;
  const fixture = setup(async (url, options) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: ["one", "two", "three"].map(freeRow) });
    requests++;
    return new Promise<Response>((resolve, reject) => {
      releases.push(() => resolve(successfulProbe()));
      options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  }, undefined, true);
  try {
    const pending = fixture.service.saveKey(secret);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 2);
    assert.equal(fixture.service.catalog().length, 0);
    fixture.service.clearKey();
    releases.forEach(release => release());
    await pending;
    assert.equal(requests, 2);
    assert.equal(fixture.service.catalog().length, 0);
    assert.equal(fixture.storage.getConfigValue("openrouter-free-models-v1"), "{}");
  } finally { fixture.close(); }
});

test("Key 在探测中替换，迟到成功不得重新发布旧模型", async () => {
  let releaseOld!: () => void;
  const fixture = setup(async (url, options) => {
    const oldKey = new Headers(options!.headers).get("authorization") === "Bearer old-key";
    if (String(url).endsWith("/models/user")) return Response.json({ data: [freeRow(oldKey ? "old" : "new")] });
    if (oldKey) return new Promise<Response>(resolve => { releaseOld = () => resolve(successfulProbe()); });
    return successfulProbe();
  }, undefined, true);
  try {
    const old = fixture.service.saveKey("old-key");
    await new Promise(resolve => setImmediate(resolve));
    await fixture.service.saveKey("new-key");
    releaseOld();
    await old;
    assert.deepEqual(fixture.service.catalog().map(model => model.id), [OPENROUTER_FREE_SELECTOR]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "new");
  } finally { fixture.close(); }
});

test("单模型探测有20秒超时，超时失败不阻止其他模型验证", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  let deadline: AbortController | null = null;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds !== 20000) return originalTimeout(milliseconds);
    deadline = new AbortController();
    return deadline.signal;
  });
  const fixture = setup(async (url, options) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: [freeRow("timeout"), freeRow("ok")] });
    const model = JSON.parse(String(options!.body)).model;
    if (model === "ok") return successfulProbe();
    const signal = options!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      setImmediate(() => deadline!.abort(new DOMException("timed out", "TimeoutError")));
    });
  }, undefined, true);
  try {
    const status = await fixture.service.saveKey(secret);
    assert.equal(status.modelCount, 1);
    assert.equal(status.rejectedCount, 1);
    assert.equal(fixture.service.catalog()[0]!.id, OPENROUTER_FREE_SELECTOR);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "ok");
  } finally { fixture.close(); }
});

test("每次调用必须查最新价格，持续免费复用已验证记录并可跨重启复用", async () => {
  let discovery = 0;
  let probes = 0;
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).endsWith("/models/user")) { discovery++; return Response.json({ data: [freeRow()] }); }
    probes++; return successfulProbe();
  };
  const fixture = setup(fetchImpl, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    for (let i = 0; i < 3; i++) assert.equal((await fixture.service.resolveForCall(selector)).model.id, "vendor/agent:free");
    assert.equal(discovery, 4);
    assert.equal(probes, 1);
    const restored = new OpenRouterFreeModelsService(fixture.storage, fetchImpl);
    try {
      assert.equal((await restored.resolveForCall(selector)).model.id, "vendor/agent:free");
      assert.equal(discovery, 5);
      assert.equal(probes, 1);
    } finally { restored.dispose(); }
  } finally { fixture.close(); }
});

test("调用时收费或下架的模型跳过，换用当前免费且已验证的其他模型并更新分组", async () => {
  let changed = false;
  let probes = 0;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: [
      { ...freeRow("first"), ...(changed ? { pricing: { prompt: "0.01", completion: "0" } } : {}) },
      freeRow("second"), ...(!changed ? [freeRow("missing")] : []),
    ] });
    probes++; return successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    changed = true;
    assert.equal((await fixture.service.resolveForCall(`${OPENROUTER_FREE_PROVIDER}/first`)).model.id, "second");
    assert.equal((await fixture.service.resolveForCall(`${OPENROUTER_FREE_PROVIDER}/missing`)).model.id, "second");
    assert.deepEqual(fixture.service.catalog().map(model => model.id), [OPENROUTER_FREE_SELECTOR]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "second");
    assert.equal(probes, 3, "替补无需重复探测");
    const cache = fixture.storage.getConfigValue("openrouter-free-models-v1")!;
    assert.equal(cache.includes('"id":"first"'), false);
  } finally { fixture.close(); }
});

test("免费→收费→免费必须重新测试；未验证替补只有回复成功后才能使用", async () => {
  let phase = 0;
  let probes = 0;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: phase === 1 ? [] : [freeRow()] });
    probes++; return phase === 2 ? Response.json({}, { status: 429 }) : successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    phase = 1;
    await assert.rejects(fixture.service.resolveForCall(selector), /没有已验证且免费的模型/);
    phase = 2;
    await assert.rejects(fixture.service.resolveForCall(selector), /没有已验证且免费的模型/);
    assert.equal(fixture.service.resolve(selector), null);
    phase = 3;
    assert.equal((await fixture.service.resolveForCall(selector)).model.id, "vendor/agent:free");
    assert.equal(probes, 3);
  } finally { fixture.close(); }
});

test("价格检查失败不可沿用缓存或发测试消息，提供方错误不泄漏凭据", async () => {
  let fail = false;
  let probes = 0;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) {
      if (fail) throw new Error(secret);
      return Response.json({ data: [freeRow()] });
    }
    probes++; return successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    fail = true;
    await assert.rejects(fixture.service.resolveForCall(selector), error => {
      assert.match(String(error), /价格检查失败/);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
    assert.equal(probes, 1);
    assert.equal(fixture.service.status().modelCount, 1, "目录可保留，但不能绕过调用前检查");
  } finally { fixture.close(); }
});

test("价格检查中清除 Key 或关闭服务，迟到响应不能选择模型或重新写缓存", async () => {
  let wait = false;
  let release!: () => void;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) {
      if (wait) return new Promise<Response>(resolve => { release = () => resolve(Response.json({ data: [freeRow()] })); });
      return Response.json({ data: [freeRow()] });
    }
    return successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    wait = true;
    const pending = fixture.service.resolveForCall(selector);
    fixture.service.clearKey();
    release();
    await assert.rejects(pending, /配置或目录已变化/);
    assert.equal(fixture.storage.getConfigValue("openrouter-free-models-v1"), "{}");
  } finally { fixture.close(); }
});

test("并发价格检查迟到的旧免费目录不能覆盖较新的收费结果", async () => {
  let mode = "initial";
  let release!: () => void;
  const fixture = setup(async (url) => {
    if (String(url).endsWith("/models/user")) {
      if (mode === "old") return new Promise<Response>(resolve => { release = () => resolve(Response.json({ data: [freeRow()] })); });
      return Response.json({ data: mode === "paid" ? [] : [freeRow()] });
    }
    return successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    mode = "old";
    const old = fixture.service.resolveForCall(selector);
    mode = "paid";
    await assert.rejects(fixture.service.resolveForCall(selector), /没有已验证且免费的模型/);
    release();
    await assert.rejects(old, /配置或目录已变化/);
    assert.equal(fixture.service.catalog().length, 0);
  } finally { fixture.close(); }
});

test("只筛选语言模型：可看图的语言模型保留，图像/视频/音频及混合生成模型排除", () => {
  const text = freeRow("text");
  const vision = freeRow("vision");
  const rejected = [
    ["image"], ["video"], ["audio"], ["text", "image"],
    ["text", "video"], ["text", "audio"], ["text", "unknown"], [],
  ].map((output, index) => ({ ...freeRow(`generated-${index}`), architecture: {
    input_modalities: ["text"], output_modalities: output,
  } }));
  const parsed = parseOpenRouterFreeModels({ data: [
    { ...text, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    vision, ...rejected,
    { ...freeRow("no-text-input"), architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
    { ...freeRow("unknown-input"), architecture: { output_modalities: ["text"] } },
    { ...freeRow("unknown-output"), architecture: { input_modalities: ["text"] } },
  ] });
  assert.deepEqual(parsed.map(model => model.id), ["text", "vision"]);
  assert.deepEqual(parsed[0]!.input, ["text"]);
  assert.deepEqual(parsed[1]!.input, ["text", "image"]);
});

test("语言类型过滤用于同步及调用前检查，变成图像生成模型会换用语言模型且不探测图像模型", async () => {
  let generated = false;
  const probed: string[] = [];
  const fixture = setup(async (url, options) => {
    if (String(url).endsWith("/models/user")) return Response.json({ data: [
      { ...freeRow("first"), architecture: { input_modalities: ["text"], output_modalities: generated ? ["text", "image"] : ["text"] } },
      freeRow("second"),
      { ...freeRow("video"), architecture: { input_modalities: ["text"], output_modalities: ["video"] } },
    ] });
    probed.push(JSON.parse(String(options!.body)).model);
    return successfulProbe();
  }, undefined, true);
  try {
    await fixture.service.saveKey(secret);
    assert.deepEqual(probed, ["first", "second"]);
    generated = true;
    assert.equal((await fixture.service.resolveForCall(`${OPENROUTER_FREE_PROVIDER}/first`)).model.id, "second");
    assert.deepEqual(fixture.service.catalog().map(model => model.id), [OPENROUTER_FREE_SELECTOR]);
    assert.equal(fixture.service.resolve(OPENROUTER_FREE_SELECTOR)?.model.id, "second");
    assert.deepEqual(probed, ["first", "second"]);
  } finally { fixture.close(); }
});

test("旧筛选规则缓存不得复活曾被当作文本模型的图像生成模型", async () => {
  const fixture = setup(async () => Response.json({ data: [freeRow()] }));
  try {
    await fixture.service.saveKey(secret);
    const cache = JSON.parse(fixture.storage.getConfigValue("openrouter-free-models-v1")!);
    cache.probeVersion = 1;
    fixture.storage.setConfigValue("openrouter-free-models-v1", JSON.stringify(cache));
    const restored = new OpenRouterFreeModelsService(fixture.storage);
    try {
      assert.deepEqual(restored.catalog(), []);
      assert.equal(restored.resolve(selector), null);
      assert.equal(restored.status().lastSyncedAt, null);
    } finally { restored.dispose(); }
  } finally { fixture.close(); }
});
