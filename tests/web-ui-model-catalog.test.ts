import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CATALOG_DEFAULT_VALUE,
  cachedWandModelCatalog,
  loadWandModelCatalog,
  normalizeWandModelCatalog,
  pickedModelId,
  wandModelOptions,
} from "../src/web-ui/react/model-catalog.js";
import {
  ISSUE_AGENT_DEFAULT_MODEL,
  issueAgentModelOptions,
  normalizeIssueModelCatalog,
} from "../src/web-ui/react/issues/task-board-agent.js";

test("board and workspace selectors share one catalog implementation", () => {
  // 两处入口曾经各写一份归一化；共用同一函数后，改一处不会再只生效一半。
  assert.equal(normalizeIssueModelCatalog, normalizeWandModelCatalog);
  assert.equal(issueAgentModelOptions, wandModelOptions);
  assert.equal(ISSUE_AGENT_DEFAULT_MODEL, MODEL_CATALOG_DEFAULT_VALUE);
});

test("picker value converts to a request model id, default stays empty", () => {
  assert.equal(pickedModelId("default"), "");
  assert.equal(pickedModelId(""), "");
  assert.equal(pickedModelId("   "), "");
  assert.equal(pickedModelId(undefined), "");
  assert.equal(pickedModelId(null), "");
  assert.equal(pickedModelId("  opus  "), "opus");
  // 显式叫 default 的真实模型（服务端列表里出现过 `default`）依旧按「跟随默认」处理。
  assert.equal(pickedModelId("Default"), "Default");
});

test("catalog fallback keeps the select usable before /api/models lands", () => {
  assert.deepEqual(wandModelOptions(null, "pi"), [
    { value: MODEL_CATALOG_DEFAULT_VALUE, label: "跟随服务端默认" },
  ]);
  const catalog = normalizeWandModelCatalog({ piModels: [{ id: "pi-1" }] });
  assert.deepEqual(wandModelOptions(catalog, "pi").map((option) => option.value), ["default", "pi-1"]);
  // 每个 provider 都有兜底项，选择器不会出现空列表。
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const) {
    assert.ok(wandModelOptions(catalog, provider).length >= 1, provider);
  }
});

test("登录前那次 401 不写缓存，下一次打开对话框会重试", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let unauthorized = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (unauthorized) return new Response(JSON.stringify({ error: "未登录" }), { status: 401 });
    return new Response(JSON.stringify({ models: [{ id: "opus", label: "Opus" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    // 先把上一次成功请求的缓存清掉：模块级缓存跨测试存活，用 TTL 无法清。
    const snapshot = cachedWandModelCatalog();
    assert.equal(snapshot, null, "this test must start from a cold cache");
    await assert.rejects(() => loadWandModelCatalog(), /未登录/);
    assert.equal(cachedWandModelCatalog(), null, "失败不能留下缓存，否则选择器永远停在占位项");

    unauthorized = false;
    const loaded = await loadWandModelCatalog();
    assert.deepEqual(loaded.byProvider.claude.map((option) => option.value), ["default", "opus"]);
    assert.equal(cachedWandModelCatalog(), loaded, "成功后供 UI 取同步初值");
    // 热缓存不再重发请求。
    await loadWandModelCatalog();
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
