import assert from "node:assert/strict";
import test from "node:test";
import { OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR } from "../src/openrouter-free-selection.js";
import { AUTO_ASSIGN_LABEL, AUTO_ASSIGN_SELECTOR } from "../src/model-groups.js";
import { modelDisplayName } from "../src/web-ui/browser/composer-select-values.js";

import {
  MODEL_CATALOG_DEFAULT_VALUE,
  cachedWandModelCatalog,
  loadWandModelCatalog,
  normalizeWandModelCatalog,
  pickedModelId,
  wandModelDisplayName,
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

test("default 哨兵显示成服务端默认模型的名字，不是「默认模型」", () => {
  const catalog = normalizeWandModelCatalog({
    models: [{ id: "default", label: "跟随 Claude Code 默认" }, { id: "opus", label: "opus（最新 Opus）" }],
    codexModels: [{ id: "default", label: "GPT-6-Astra · gpt-6-astra（Codex 默认）" }],
    opencodeModels: [{ id: "default", label: "跟随 OpenCode 默认" }],
    defaultModels: { claude: "opus" },
  });
  assert.equal(wandModelDisplayName(catalog, "claude", "default"), "opus", "服务端配了默认模型就用它的名字");
  assert.equal(wandModelDisplayName(catalog, "claude", ""), "opus", "空值也是同一个哨兵");
  assert.equal(wandModelDisplayName(catalog, "codex", "default"), "GPT-6-Astra · gpt-6-astra",
    "没配默认模型时取 CLI 报出来的默认项名字");
  assert.equal(wandModelDisplayName(catalog, "opencode", "default"), "", "只有「跟随默认」这种文案时宁可不显示");
  assert.equal(wandModelDisplayName(
    normalizeWandModelCatalog({ models: [{ id: "default", label: "跟随 Claude Code 默认" }] }),
    "claude",
    "default",
  ), "", "多词的「跟随 X 默认」文案同样不算名字");
  assert.equal(wandModelDisplayName(catalog, "claude", "sonnet"), "sonnet", "显式选的模型原样显示 id");
  assert.equal(wandModelDisplayName(catalog, "session", "default"), "", "认不出的 provider 不猜名字");
  assert.equal(wandModelDisplayName(null, "claude", "default"), "", "目录没到时解析不出名字");
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

test("免费分组可直接选择，任务及员工展示名称不泄漏选择器ID", () => {
  const catalog = normalizeWandModelCatalog({
    piModels: [{ id: OPENROUTER_FREE_SELECTOR, label: OPENROUTER_FREE_GROUP }],
    defaultModels: { pi: OPENROUTER_FREE_SELECTOR },
  });
  assert.deepEqual(wandModelOptions(catalog, "pi")[1], {
    value: OPENROUTER_FREE_SELECTOR, label: "免费分组",
  });
  assert.equal(wandModelOptions(catalog, "pi")[0]!.label, "跟随服务端默认（免费分组）");
  assert.equal(pickedModelId(OPENROUTER_FREE_SELECTOR), OPENROUTER_FREE_SELECTOR);
  assert.equal(wandModelDisplayName(catalog, "pi", OPENROUTER_FREE_SELECTOR), "免费分组");
  assert.equal(wandModelDisplayName(catalog, "pi", "default"), "免费分组");
  assert.equal(wandModelDisplayName(null, "pi", OPENROUTER_FREE_SELECTOR), "免费分组");
});

test("免费模型的分组元数据传到任务及员工模型选择器", () => {
  const model = { id: "wand-openrouter-free/vendor/model:free", label: "Free Model", group: "免费分组" };
  const catalog = normalizeWandModelCatalog({ piModels: [model] });
  assert.deepEqual(wandModelOptions(catalog, "pi")[1], {
    value: model.id, label: model.label, group: "免费分组",
  });
});

test("智能分配按服务端给的 label 展示，且能原样进入请求体", () => {
  const catalog = normalizeWandModelCatalog({ piModels: [
    { id: "default", label: "跟随 one 的 Agent 默认" },
    { id: AUTO_ASSIGN_SELECTOR, label: AUTO_ASSIGN_LABEL },
    { id: "openai-codex/gpt-6.1-sol", label: "GPT-6.1-Sol" },
  ], defaultModels: { pi: AUTO_ASSIGN_SELECTOR } });
  const options = wandModelOptions(catalog, "pi");
  assert.deepEqual(options[1], { value: AUTO_ASSIGN_SELECTOR, label: AUTO_ASSIGN_LABEL });
  assert.equal(wandModelDisplayName(catalog, "pi", AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_LABEL);
  assert.equal(wandModelDisplayName(null, "pi", AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_LABEL,
    "目录没加载时也要显示人读名，而不是裸选择器");
  assert.equal(wandModelDisplayName(catalog, "pi", "default"), AUTO_ASSIGN_LABEL,
    "默认项文案按服务端默认模型渲染");
  assert.equal(pickedModelId(AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_SELECTOR, "选择器原样提交给服务端结算");
  assert.equal(modelDisplayName(AUTO_ASSIGN_SELECTOR, [{ id: AUTO_ASSIGN_SELECTOR, label: AUTO_ASSIGN_LABEL }], ""),
    AUTO_ASSIGN_LABEL, "终端/聊天 chip 与 React 侧同口径");
  assert.equal(modelDisplayName(AUTO_ASSIGN_SELECTOR, [], AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_LABEL,
    "browser 侧目录没加载时也不显示裸选择器");
});
