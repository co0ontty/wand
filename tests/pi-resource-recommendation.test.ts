import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { DecisionError, type DecisionResult } from "../src/decision-types.js";
import { parsePiRecommendationRequest, recommendPiResources } from "../src/pi-resource-recommendation.js";
import { defaultPiCliSessionSettings, type PiResourceCatalog } from "../src/pi-session-settings.js";
import { discoverPiResources } from "../src/pi-resource-catalog.js";
import { registerPiRecommendationRoute } from "../src/server-pi-recommendation-routes.js";

const skill = (n: string) => `skill-${n.repeat(24)}`;
const mcp = `mcp-${"a".repeat(24)}`;
const catalog: PiResourceCatalog = { supported: true, reason: "", skills: [
  { id: skill("a"), name: "frontend-design", description: "Design and implement web pages", source: "已安装" },
  { id: skill("b"), name: "mermaid", description: "Draw documentation diagrams", source: "已安装" },
], mcpServers: [{ id: mcp, name: "docs", description: "已配置的本地 MCP 服务", source: "用户配置" }] };
const candidates = { skills: catalog.skills.map((item) => item.id), mcpServers: [mcp] };
function rankedAnswer(raw: unknown, preferredName: string | null): DecisionResult {
  const request = raw as { questions: Record<string, { criteria: Record<string, string> }> };
  const answers: DecisionResult["answers"] = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const labels = Object.keys(question.criteria);
    const preferred = preferredName && labels.find((label) => question.criteria[label]!.startsWith(`${preferredName}:`));
    const choice = preferred ?? (preferredName ? labels.find((label) => label !== "none") : "none") ?? "none";
    const remainder = labels.length > 1 ? 0.05 / (labels.length - 1) : 0;
    answers[id] = { type: "choice", choice, probabilities: Object.fromEntries(labels.map((label) =>
      [label, label === choice ? 0.95 : remainder])) };
  }
  return { model: "fixture", experimental: true, runtime: "laya-mlx",
    usage: { input_tokens: 30, output_tokens: 0, truncated: false }, answers };
}

test("recommendation request rejects paths, extra authority, overlength prompts and too many candidates", () => {
  assert.deepEqual(parsePiRecommendationRequest({ prompt: " 做一个页面 ", candidates }), { prompt: "做一个页面", candidates });
  for (const raw of [null, { prompt: "/settings", candidates }, { prompt: "x".repeat(1201), candidates },
    { prompt: "x", candidates, agentDir: "/tmp" }, { prompt: "x", candidates: { skills: [mcp], mcpServers: [] } },
    { prompt: "x", candidates: { skills: ["/tmp/SKILL.md"], mcpServers: [] } },
    { prompt: "x", candidates: { skills: Array.from({ length: 25 }, (_, i) => `skill-${i.toString(16).padStart(24, "0")}`), mcpServers: [] } }]) {
    assert.throws(() => parsePiRecommendationRequest(raw));
  }
});

test("explicit names and exclusions are respected; unidentified MCP is not connected or semantically guessed", async () => {
  let calls = 0;
  const result = await recommendPiResources({ prompt: "使用 frontend-design，不要 mermaid。", candidates, catalog,
    caller: "test", evaluate: async () => { calls++; throw new Error("must not infer"); } });
  assert.deepEqual(result.selection, { skills: [skill("a")], mcpServers: [] });
  assert.equal(result.resources.find((item) => item.id === skill("b"))?.status, "unmatched");
  assert.equal(result.resources.find((item) => item.id === mcp)?.status, "unassessed");
  assert.equal(calls, 0);
  const selectedMcp = await recommendPiResources({ prompt: "使用 docs，不使用 frontend-design，也不用 mermaid。", candidates,
    catalog, caller: "test", evaluate: async () => { throw new Error("must not infer"); } });
  assert.deepEqual(selectedMcp.selection, { skills: [], mcpServers: [mcp] });
  const suffixExcluded = await recommendPiResources({ prompt: "mermaid 不用，frontend-design 也不要，docs 这次不连接。", candidates,
    catalog, caller: "test", evaluate: async () => { throw new Error("must not infer"); } });
  assert.deepEqual(suffixExcluded.selection, { skills: [], mcpServers: [] });
});

test("standalone resource controls stay out of semantic matching without dropping business constraints", async () => {
  for (const [prompt, expected] of [
    ["设计页面，不要 mermaid", "设计页面"],
    ["设计页面，mermaid 也不要", "设计页面"],
    ["设计页面，do not use mermaid", "设计页面"],
    ["设计页面，不要改变数据库，不用 mermaid", "设计页面，不要改变数据库"],
    ["设计页面，不要用图表替代正文", "设计页面，不要用图表替代正文"],
  ]) {
    const result = await recommendPiResources({ prompt, candidates, catalog, caller: "test", evaluate: async (raw) => {
      assert.equal((raw as { state: string }).state, expected);
      return rankedAnswer(raw, null);
    } });
    assert.deepEqual(result.selection.skills, []);
  }
  const result = await recommendPiResources({ prompt: "使用 mermaid", candidates, catalog, caller: "test",
    evaluate: async () => { throw new Error("resource switches alone need no semantic inference"); } });
  assert.deepEqual(result.selection.skills, [skill("b")]);
});

test("the system decision role ranks the candidate set with descriptions in one bounded call", async () => {
  let calls = 0;
  const result = await recommendPiResources({ prompt: "设计页面", candidates, catalog, caller: "test", evaluate: async (raw) => {
    calls++;
    const request = raw as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
    assert.equal(request.state, "设计页面");
    assert.deepEqual(Object.keys(request.questions), ["g0f", "g0r"]);
    assert.ok(Object.values(request.questions).every((question) => Object.values(question.criteria)
      .some((description) => description.startsWith("frontend-design:"))));
    return rankedAnswer(raw, "frontend-design");
  } });
  assert.deepEqual(result.selection, { skills: [skill("a")], mcpServers: [] });
  assert.equal(result.resources.find((item) => item.id === skill("b"))?.status, "uncertain");
  assert.equal(calls, 1);
  assert.equal(result.calls, 1);
  const limited = await recommendPiResources({ prompt: "复杂任务", candidates, catalog, caller: "test",
    evaluate: async () => { throw new DecisionError("CONTEXT_LIMIT", "too long"); } });
  assert.deepEqual(limited.selection, { skills: [], mcpServers: [] });
  assert.ok(limited.resources.every((item) => item.status === "unassessed"));
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test",
    evaluate: async () => { throw new DecisionError("UNAVAILABLE", "unavailable"); } }), /unavailable/);
});

test("large catalogs use bounded group and final decisions; disagreement, limits and cancellation select nothing", async () => {
  const largeCatalog: PiResourceCatalog = { supported: true, reason: "", mcpServers: [], skills: Array.from({ length: 9 }, (_, index) => ({
    id: `skill-${index.toString(16).padStart(24, "0")}`, name: index === 7 ? "target-skill" : `skill-${index}`,
    description: index === 7 ? "The best specialist for this task" : `Unrelated specialist ${index}`, source: "已安装",
  })) };
  const largeCandidates = { skills: largeCatalog.skills.map((item) => item.id), mcpServers: [] };
  let calls = 0;
  const selected = await recommendPiResources({ prompt: "完成目标任务", candidates: largeCandidates, catalog: largeCatalog,
    caller: "test", evaluate: async (raw) => { calls++; return rankedAnswer(raw, "target-skill"); } });
  assert.deepEqual(selected.selection.skills, [largeCatalog.skills[7]!.id]);
  assert.equal(calls, 2); assert.equal(selected.calls, 2);

  const only = { skills: [skill("a")], mcpServers: [] };
  const disagreement = await recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test",
    evaluate: async (raw) => {
      const result = rankedAnswer(raw, "frontend-design");
      const reverse = result.answers.g0r! as { choice: string; probabilities: Record<string, number> };
      reverse.choice = "none"; reverse.probabilities = { s0: 0.05, none: 0.95 };
      return result;
    } });
  assert.deepEqual(disagreement.selection.skills, []);
  assert.equal(disagreement.resources[0]!.status, "uncertain");
  for (const code of ["QUESTION_LIMIT", "CONTEXT_LIMIT", "OPTIONS_COLLAPSED"]) {
    const result = await recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test",
      evaluate: async () => { throw new DecisionError(code, "too long"); } });
    assert.deepEqual(result.selection.skills, []);
    assert.equal(result.resources[0]!.status, "unassessed");
  }
  const abort = new AbortController(); let abortedCalls = 0;
  await assert.rejects(recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test", signal: abort.signal,
    evaluate: async (raw) => { abortedCalls++; abort.abort(); return rankedAnswer(raw, "frontend-design"); } }), /取消/);
  assert.equal(abortedCalls, 1);
});

test("invalid choice distributions and labels are rejected before they can select a Skill", async () => {
  for (const mutate of [
    (result: DecisionResult) => { (result.answers.g0f!.probabilities as Record<string, number>).none = 0.95; },
    (result: DecisionResult) => { result.answers.g0f!.choice = "other"; },
    (result: DecisionResult) => { result.answers.g0f = { type: "noul", noul: 0.95 }; },
  ]) {
    await assert.rejects(recommendPiResources({ prompt: "设计页面", candidates, catalog, caller: "test", evaluate: async (raw) => {
      const result = rankedAnswer(raw, "frontend-design"); mutate(result); return result;
    } }), /无效/);
  }
});

test("removed candidates, invalid probabilities and cancellation never produce actionable recommendations", async () => {
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates: { skills: [skill("0")], mcpServers: [] },
    catalog, caller: "test", evaluate: async (raw) => rankedAnswer(raw, null) }), /移除/);
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test", evaluate: async (raw) => {
    const result = rankedAnswer(raw, "frontend-design");
    (result.answers.g0f!.probabilities as Record<string, number>).s0 = NaN; return result;
  } }), /无效/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test",
    signal: controller.signal, evaluate: async (raw) => rankedAnswer(raw, null) }), /取消/);
});

test("HTTP recommendation stays read-only, validates owner/engine/local toggle and rejects busy or changed sessions", { timeout: 12_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-recommend-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  mkdirSync(path.join(agentDir, "skills", "web-design"), { recursive: true });
  writeFileSync(path.join(agentDir, "skills", "web-design", "SKILL.md"), "---\nname: web-design\ndescription: Create web pages\n---\n# Design\n");
  const config = { harness: { engine: "cli" as const, agentDir } };
  const inventory = await discoverPiResources(config, root);
  const ids = { skills: [inventory.catalog.skills.find((item) => item.name === "web-design")!.id], mcpServers: [] };
  let target: any = { id: "test", provider: "pi", cwd: root, archived: false, piSettings: defaultPiCliSessionSettings() };
  let engine = "cli", owner: string | null = "structured", evaluations = 0;
  let deferred: ((result: DecisionResult) => void) | null = null;
  let deferredRequest: unknown;
  let delay = false;
  const initial = JSON.stringify(target);
  const app = express(); app.use(express.json());
  // Mirror the parent route's authorization boundary: inference-only credentials are not login.
  app.use((req, res, next) => { if (req.get("Authorization") !== "Bearer synthetic-login") res.sendStatus(401); else next(); });
  registerPiRecommendationRoute(app, { config: config as any,
    sessions: { ownerOf: () => owner } as any,
    structured: { get: () => target, getPiSettings: () => ({ settings: target.piSettings, resolution: { engine } }) } as any,
    decisions: { status: () => ({ enabled: true, supported: true, configured: true }) as any,
      evaluate: async (raw: unknown) => { evaluations++; deferredRequest = raw;
        return delay ? new Promise<DecisionResult>((resolve) => { deferred = resolve; }) : rankedAnswer(raw, "web-design"); } },
  });
  const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/test/pi-settings/recommend`;
  const post = (body: unknown = { prompt: "制作网页", candidates: ids }) => fetch(url, { method: "POST",
    headers: { Authorization: "Bearer synthetic-login", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  const response = await post(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).selection, ids);
  assert.equal(JSON.stringify(target), initial, "recommendation must not mutate session settings or history");
  owner = null; assert.equal((await post()).status, 404); owner = "pty"; assert.equal((await post()).status, 400); owner = "structured";
  engine = "core"; assert.equal((await post()).status, 400); engine = "cli";
  target.piSettings.localDecision = false; assert.equal((await post()).status, 503); target.piSettings.localDecision = true;
  const before = evaluations;
  assert.equal((await post({ prompt: "制作网页", candidates: { skills: [skill("0")], mcpServers: [] } })).status, 400);
  assert.equal(evaluations, before);
  delay = true;
  const pending = post();
  for (let i = 0; i < 100 && !deferred; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(deferred);
  assert.equal((await post()).status, 409);
  target = { ...target, archived: true };
  delay = false;
  (deferred as (value: DecisionResult) => void)(rankedAnswer(deferredRequest, "web-design"));
  assert.equal((await pending).status, 409, "a stale session cannot return an actionable recommendation");
});
