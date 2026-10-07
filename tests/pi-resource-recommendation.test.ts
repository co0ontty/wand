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
const answer = (relevant: number, excluded: number): DecisionResult => ({ model: "fixture", experimental: true,
  runtime: "laya-mlx", usage: { input_tokens: 30, output_tokens: 0, truncated: false },
  answers: {
    forward: { type: "choice", choice: relevant >= 0.5 ? "match" : "none", probabilities: { match: relevant, none: 1 - relevant } },
    reverse: { type: "choice", choice: excluded <= 0.5 ? "match" : "none", probabilities: { match: 1 - excluded, none: excluded } },
    relevant: { type: "noul", noul: relevant },
  } });

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
      return answer(0.1, 0.9);
    } });
    assert.deepEqual(result.selection.skills, []);
  }
  const result = await recommendPiResources({ prompt: "使用 mermaid", candidates, catalog, caller: "test",
    evaluate: async () => { throw new Error("resource switches alone need no semantic inference"); } });
  assert.deepEqual(result.selection.skills, [skill("b")]);
});

test("shortlist requires stable choices before complete-description confirmation; limits remain unselected", async () => {
  let calls = 0;
  const result = await recommendPiResources({ prompt: "设计页面", candidates, catalog, caller: "test", evaluate: async (raw) => {
    calls++;
    const value = raw as { state: string | { task: string; resource: { name: string } };
      questions: { forward?: { criteria: { match: string } } } };
    assert.equal(typeof value.state === "string" ? value.state : value.state.task, "设计页面");
    const name = typeof value.state === "string" ? value.questions.forward!.criteria.match : value.state.resource.name;
    return name === "frontend-design" ? answer(0.9, 0.1) : answer(0.97, 0.96);
  } });
  assert.deepEqual(result.selection, { skills: [skill("a")], mcpServers: [] });
  assert.equal(result.resources.find((item) => item.id === skill("b"))?.status, "uncertain");
  assert.equal(calls, 3);
  assert.equal(result.calls, 3);
  const limited = await recommendPiResources({ prompt: "复杂任务", candidates, catalog, caller: "test",
    evaluate: async () => { throw new DecisionError("CONTEXT_LIMIT", "too long"); } });
  assert.deepEqual(limited.selection, { skills: [], mcpServers: [] });
  assert.ok(limited.resources.every((item) => item.status === "unassessed"));
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test",
    evaluate: async () => { throw new DecisionError("UNAVAILABLE", "unavailable"); } }), /unavailable/);
});

test("name matches cannot bypass the full description, cancellation or budget rejection", async () => {
  const only = { skills: [skill("a")], mcpServers: [] };
  for (const confirmation of [0.1, 0.5, 0.95]) {
    let calls = 0;
    const result = await recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test", evaluate: async (raw) => {
      const request = raw as { state: unknown; questions: Record<string, { instructions: string }> };
      calls++;
      if (calls === 1) {
        assert.equal(request.state, "设计页面", "the short pass must contain only the unchanged task");
        assert.deepEqual(Object.keys(request.questions), ["forward", "reverse"]);
        assert.ok(Object.values(request.questions).every((question) => question.instructions.length < 40));
        return answer(0.95, 0.05);
      }
      assert.deepEqual(request.state, { task: "设计页面", resource: {
        name: catalog.skills[0]!.name, description: catalog.skills[0]!.description,
      } });
      assert.deepEqual(Object.keys(request.questions), ["relevant"]);
      return answer(confirmation, 1 - confirmation);
    } });
    assert.equal(calls, 2);
    assert.deepEqual(result.selection.skills, confirmation >= 0.8 ? only.skills : []);
  }
  for (const code of ["QUESTION_LIMIT", "CONTEXT_LIMIT", "OPTIONS_COLLAPSED"]) {
    let calls = 0;
    const result = await recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test", evaluate: async () => {
      if (++calls === 1) return answer(0.95, 0.05);
      throw new DecisionError(code, "too long");
    } });
    assert.deepEqual(result.selection.skills, []);
    assert.equal(result.resources[0]!.status, "unassessed");
  }
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(recommendPiResources({ prompt: "设计页面", candidates: only, catalog, caller: "test", signal: abort.signal,
    evaluate: async () => { calls++; abort.abort(); return answer(0.95, 0.05); } }), /取消/);
  assert.equal(calls, 1, "stopping after shortlist must prevent description confirmation");
});

test("invalid choice distributions and labels are rejected before confirmation", async () => {
  for (const forward of [
    { type: "choice", choice: "match", probabilities: { match: 0.95, none: 0.95 } },
    { type: "choice", choice: "none", probabilities: { match: 0.95, none: 0.05 } },
    { type: "choice", choice: "other", probabilities: { match: 0.95, none: 0.05 } },
    { type: "noul", noul: 0.95 },
  ]) {
    await assert.rejects(recommendPiResources({ prompt: "设计页面", candidates, catalog, caller: "test", evaluate: async () => ({
      ...answer(0.95, 0.05), answers: { ...answer(0.95, 0.05).answers, forward },
    }) }), /无效/);
  }
});

test("removed candidates, invalid probabilities and cancellation never produce actionable recommendations", async () => {
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates: { skills: [skill("0")], mcpServers: [] },
    catalog, caller: "test", evaluate: async () => answer(1, 0) }), /移除/);
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test",
    evaluate: async () => answer(NaN, 0) }), /无效/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recommendPiResources({ prompt: "任务", candidates, catalog, caller: "test",
    signal: controller.signal, evaluate: async () => answer(1, 0) }), /取消/);
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
  let delay = false;
  const initial = JSON.stringify(target);
  const app = express(); app.use(express.json());
  // Mirror the parent route's authorization boundary: inference-only credentials are not login.
  app.use((req, res, next) => { if (req.get("Authorization") !== "Bearer synthetic-login") res.sendStatus(401); else next(); });
  registerPiRecommendationRoute(app, { config: config as any,
    sessions: { ownerOf: () => owner } as any,
    structured: { get: () => target, getPiSettings: () => ({ settings: target.piSettings, resolution: { engine } }) } as any,
    decisions: { status: () => ({ enabled: true, supported: true, configured: true }) as any,
      evaluate: async () => { evaluations++; return delay ? new Promise<DecisionResult>((resolve) => { deferred = resolve; }) : answer(0.95, 0.05); } },
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
  (deferred as (value: DecisionResult) => void)(answer(1, 0));
  assert.equal((await pending).status, 409, "a stale session cannot return an actionable recommendation");
});
