import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationDetail } from "../src/conversation-types.js";
import type { WandTaskAgent } from "../src/task-types.js";
import { composerRuntimePreference, directWorkPreference, latestDirectWork } from "../src/web-ui/react/conversations/composer-presentation.ts";
import { normalizeWandModelCatalog } from "../src/web-ui/react/model-catalog.ts";
import { executionFailure } from "../src/web-ui/react/conversations/execution-failure.ts";

test("DM continuation follows the latest available reply, never its legacy channel or another conversation", () => {
  const detail = { kind: "dm", communicationSessionId: "legacy", messages: [
    { sessionLink: { sessionId: "old", title: "已有工作" }, sessionPreview: { status: "idle" } },
    { text: "普通消息" },
    { sessionLink: { sessionId: "latest", title: "最新工作" }, sessionPreview: { status: "running" } },
    { sessionLink: { sessionId: "missing", title: "不可用" }, sessionPreview: { status: "unavailable" } },
  ] } as unknown as ConversationDetail;
  assert.deepEqual(latestDirectWork(detail), { sessionId: "latest", title: "最新工作" });
  assert.equal(latestDirectWork({ ...detail, kind: "group" }), null);
  assert.equal(latestDirectWork({ ...detail, messages: [] }), null);
  assert.equal(latestDirectWork(null), null);
  assert.equal(detail.messages.length, 4);
});

test("execution preferences distinguish Pi CLI and Wand Agent and normalize Codex permission", () => {
  const agent = { provider: "pi", engine: "cli", mode: "default" } as WandTaskAgent;
  assert.match(directWorkPreference(agent), /首选 Pi · 标准权限/);
  assert.match(directWorkPreference({ ...agent, engine: "sdk" }), /首选 Wand Agent · 标准权限/);
  assert.match(directWorkPreference({ ...agent, provider: "codex" }), /完全访问/);
  assert.equal(directWorkPreference(undefined), "执行配置未就绪");
});

test("composer preferences retain exact model versions and native thinking levels without inventing defaults", () => {
  const agent = { provider: "pi", model: "openai/gpt-5.4-mini", thinkingEffort: "pi:xhigh" } as WandTaskAgent;
  assert.deepEqual(composerRuntimePreference(agent), { model: "openai/gpt-5.4-mini", thinking: "超高" });
  assert.deepEqual(composerRuntimePreference({ ...agent, model: "default", thinkingEffort: "off" }), {
    model: "工具默认模型（待解析）", thinking: "自动（模型默认）",
  });
  assert.deepEqual(composerRuntimePreference(undefined), { model: "配置未就绪", thinking: "未取得" });
  assert.match(directWorkPreference(agent), /gpt-5\.4-mini · 思考：超高/);
  const catalog = normalizeWandModelCatalog({ defaultPiModel: "openai/gpt-5.4-mini", thinkingEfforts: { pi: [{ effort: "high" }] } });
  assert.deepEqual(composerRuntimePreference({ ...agent, model: "default", thinkingEffort: "deep" }, catalog), {
    model: "openai/gpt-5.4-mini", thinking: "高",
  });
});

test("failure summaries use explicit causes without leaking raw paths or claiming safe replay", () => {
  const raw = "Model not found: fixture/model\n/Users/private/runtime.js:42\n12345678-1234-1234-1234-123456789012";
  assert.equal(executionFailure(raw).action, "model");
  assert.doesNotMatch(executionFailure(raw).summary, /private|12345678|未启动|重试/);
  assert.equal(executionFailure("Authentication failed: token expired").action, "login");
  assert.equal(executionFailure("Request timed out; delivery is unknown").action, "inspect");
});
