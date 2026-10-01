import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { explicitEmployeeMemoryContent, normalizeEmployeeKnowledge } from "../src/employee-knowledge-content.js";
import { startEmployeeKnowledgeRunner } from "../src/employee-knowledge.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { buildSessionSystemPromptParts } from "../src/structured-claude-adapter.js";
import { promptWithSystemFallback, systemPromptArgs } from "../src/structured-provider-common.js";
import { recordIterationPrompt, whenIterationPromptsSettled } from "../src/iteration-log.js";
import { recordUserMemory, whenUserMemorySettled } from "../src/user-memory.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext } from "../src/structured-runner.js";
import type { SessionProvider, SessionSnapshot } from "../src/types.js";

const cli = promisify(execFile);
const agent = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const makeEmployee = (id: string): SiliconEmployee => ({ id, name: id, duty: "", prompt: "原有角色规则",
  avatar: "", agents: [agent], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const snapshot = (id: string, employeeId?: string): SessionSnapshot => ({ id, employeeId, command: "pi", provider: "pi",
  sessionKind: "structured", systemPrompt: "原有角色规则", cwd: "/tmp", mode: "default", status: "idle", exitCode: null,
  startedAt: new Date().toISOString(), endedAt: null, output: "", archived: false, archivedAt: null, claudeSessionId: null });

function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), "wand-employee-knowledge-"));
  const storage = new WandStorage(join(root, "wand.db"));
  storage.saveSiliconEmployee(makeEmployee("e_a"));
  storage.saveSiliconEmployee(makeEmployee("e_b"));
  t.after(async () => {
    await whenUserMemorySettled(storage);
    await whenIterationPromptsSettled();
    storage.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, storage };
}

function fakeRunner(receive: (ctx: StructuredRunnerContext) => void): StructuredRunnerAdapter {
  return { start(ctx) {
    receive(ctx);
    return { args: [], pid: null, spawnedAt: new Date().toISOString(), interrupt() {},
      completion: Promise.resolve({ state: { blocks: [], result: "已处理", sessionId: "native" }, exitCode: 0,
        signal: null, stderr: "", primaryError: null }) };
  } };
}
const observer = { isActive: () => true, onUpdate() {} };

test("every employee has an empty independent namespace; remember is durable, deduplicated and rename-stable", (t) => {
  const { root, storage } = setup(t);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 0);
  assert.equal(storage.countEmployeeKnowledge("e_b"), 0);
  const entry = storage.rememberEmployeeKnowledge("e_a", "发布前先跑回归测试。");
  assert.equal(storage.rememberEmployeeKnowledge("e_a", "发布前先跑回归测试。").id, entry.id);
  assert.equal(storage.listEmployeeKnowledge("e_b").length, 0);
  storage.saveSiliconEmployee({ ...makeEmployee("e_a"), name: "换个名字" });
  const reopened = new WandStorage(join(root, "wand.db"));
  try { assert.equal(reopened.listEmployeeKnowledge("e_a")[0]?.content, entry.content); }
  finally { reopened.close(); }
  assert.equal(storage.forgetEmployeeKnowledge("e_b", entry.id), false);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  storage.clearEmployeeKnowledge("e_b");
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  storage.archiveSiliconEmployee("e_a");
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  storage.deleteSiliconEmployee("e_a");
  assert.throws(() => storage.listEmployeeKnowledge("e_a"), /已删除/);
  assert.equal(storage.countEmployeeKnowledge("e_b"), 0);
});

test("knowledge quota never evicts old explicit facts and Unicode duplicates keep their identity", (t) => {
  const { storage } = setup(t);
  const unicode = storage.rememberEmployeeKnowledge("e_a", "Équipe 的发布规范");
  assert.equal(storage.rememberEmployeeKnowledge("e_a", unicode.content).id, unicode.id);
  for (let index = 1; index < 200; index++) storage.rememberEmployeeKnowledge("e_a", `明确事实 ${index}`);
  assert.throws(() => storage.rememberEmployeeKnowledge("e_a", "第201条"), /已满/);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 200);
  assert.ok(storage.listEmployeeKnowledge("e_a", "", 200).some(entry => entry.id === unicode.id));
  assert.equal(storage.countEmployeeKnowledge("e_b"), 0);
});

test("knowledge search is Unicode case-insensitive, literal and employee-scoped before applying limit", (t) => {
  const { storage } = setup(t);
  const french = storage.rememberEmployeeKnowledge("e_a", "Équipe 发布规范");
  const russian = storage.rememberEmployeeKnowledge("e_a", "МОСКВА 工作窗口");
  const literal = storage.rememberEmployeeKnowledge("e_a", "100%_ready 验收标准");
  storage.rememberEmployeeKnowledge("e_b", "ÉQUIPE 别人的规范");
  storage.rememberEmployeeKnowledge("e_a", "最新但不匹配的记录");
  assert.deepEqual(storage.listEmployeeKnowledge("e_a", "équipe", 1).map(entry => entry.id), [french.id]);
  assert.deepEqual(storage.listEmployeeKnowledge("e_a", "москва").map(entry => entry.id), [russian.id]);
  assert.deepEqual(storage.listEmployeeKnowledge("e_a", "100%_READY").map(entry => entry.id), [literal.id]);
  assert.deepEqual(storage.listEmployeeKnowledge("e_a", "发布规范' OR 1=1 --"), []);
  assert.equal(storage.listEmployeeKnowledge("e_b", "москва").length, 0);
});

test("explicit requests do not treat examples, conditional language, logging tasks or reminders as knowledge", () => {
  for (const input of ["记一下：发布窗口是周五", "请你帮我记住发布窗口是周五", "存到你的知识库：发布窗口是周五", "please remember this: release is Friday"]) {
    assert.ok(explicitEmployeeMemoryContent(input)?.includes("周五") || explicitEmployeeMemoryContent(input)?.includes("Friday"));
  }
  for (const input of ["如果我说记一下，应该怎么办？", "这里举例：记一下发布窗口", "请记录日志并修复问题", "记得跑一次测试", "remember to run tests"]) {
    assert.equal(explicitEmployeeMemoryContent(input), null, input);
  }
  assert.equal(normalizeEmployeeKnowledge("文档在 https://docs.example.test/spec，路径是 /tmp/project/README.md"),
    "文档在 https://docs.example.test/spec，路径是 /tmp/project/README.md");
  assert.equal(normalizeEmployeeKnowledge("不要把密码写到日志中"), "不要把密码写到日志中");
  assert.throws(() => normalizeEmployeeKnowledge("api_key=not-a-real-key"), /不保存/);
  assert.throws(() => normalizeEmployeeKnowledge("password: fictional-value"), /不保存/);
  assert.throws(() => normalizeEmployeeKnowledge("https://user:fixture@example.test"), /不保存/);
  assert.throws(() => normalizeEmployeeKnowledge("https://example.test?token=only-fixture-value"), /不保存/);
  assert.throws(() => normalizeEmployeeKnowledge("很".repeat(4001)), /4000/);
});

test("scoped capabilities bind the actual session employee, expire/revoke, and clear invalidates late writes", (t) => {
  const { storage } = setup(t);
  storage.saveSession(snapshot("s_a", "e_a"));
  assert.throws(() => storage.issueEmployeeKnowledgeAccess("s_a", "e_b"), /不一致/);
  const now = Date.now();
  const token = storage.issueEmployeeKnowledgeAccess("s_a", "e_a", now);
  assert.equal(storage.resolveEmployeeKnowledgeAccess(token, now), "e_a");
  assert.equal(storage.resolveEmployeeKnowledgeAccess(token, now + 6 * 3600_000), null);
  storage.clearEmployeeKnowledge("e_a");
  assert.equal(storage.resolveEmployeeKnowledgeAccess(token), null);
  assert.throws(() => storage.rememberEmployeeKnowledge("e_a", "不能复活", token), /失效/);
  const next = storage.issueEmployeeKnowledgeAccess("s_a", "e_a");
  storage.revokeEmployeeKnowledgeAccess(next);
  assert.equal(storage.resolveEmployeeKnowledgeAccess(next), null);
});

test("real scoped CLI saves and searches only its employee; missing/foreign scope never falls back", async (t) => {
  const { storage } = setup(t);
  storage.saveSession(snapshot("s_a", "e_a"));
  storage.saveSession(snapshot("s_b", "e_b"));
  const tokenA = storage.issueEmployeeKnowledgeAccess("s_a", "e_a");
  const tokenB = storage.issueEmployeeKnowledgeAccess("s_b", "e_b");
  const envA = { ...process.env, WAND_KNOWLEDGE_DB: storage.databasePath(), WAND_KNOWLEDGE_TOKEN: tokenA };
  const envB = { ...envA, WAND_KNOWLEDGE_TOKEN: tokenB };
  const invoke = (env: NodeJS.ProcessEnv, command: string, ...args: string[]) => cli(process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), command, ...args], { env, timeout: 15_000 });
  const saved = JSON.parse((await invoke(envA, "knowledge:remember", "甲的发布窗口是周五")).stdout);
  assert.equal(saved.entry.employeeId, "e_a");
  assert.equal(JSON.parse((await invoke(envB, "knowledge:search", "发布窗口")).stdout).entries.length, 0);
  assert.equal(JSON.parse((await invoke(envB, "knowledge:forget", saved.entry.id)).stdout).deleted, false);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  await invoke(envA, "knowledge:remember", "Équipe / МОСКВА 的规范");
  assert.equal(JSON.parse((await invoke(envA, "knowledge:search", "équipe")).stdout).entries.length, 1);
  assert.equal(JSON.parse((await invoke(envA, "knowledge:search", "москва")).stdout).entries.length, 1);
  assert.equal(JSON.parse((await invoke(envB, "knowledge:search", "équipe")).stdout).entries.length, 0);
  await assert.rejects(invoke({ ...envA, WAND_KNOWLEDGE_TOKEN: "" }, "knowledge:remember", "不能写默认伙伴"));
  await assert.rejects(invoke(envA, "knowledge:remember", "--employee", "e_b", "跨员工"));
  // --stdin tests both bounded data input and current-scope checks after asynchronous input.
  const child = spawn(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), "knowledge:remember", "--stdin"], { env: envA });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  child.stdin.end("甲的第二条知识\n只属于甲");
  const exit = await new Promise<number | null>(resolveExit => child.once("exit", resolveExit));
  assert.equal(exit, 0); assert.equal(JSON.parse(output).entry.employeeId, "e_a");
});

test("runtime knowledge is refreshed per turn, raw user text/base/history stay untouched and inherited tokens are stripped", async (t) => {
  const { storage } = setup(t);
  storage.saveSession(snapshot("s_a", "e_a"));
  storage.saveSession(snapshot("s_b", "e_b"));
  storage.rememberEmployeeKnowledge("e_b", "乙的独立标记 B_ONLY");
  const session = storage.getSession("s_a")!;
  let first!: StructuredRunnerContext;
  const execution = startEmployeeKnowledgeRunner(storage, fakeRunner(ctx => { first = ctx; }),
    { session, prompt: "记一下：甲的独立标记 A_ONLY", env: { WAND_KNOWLEDGE_TOKEN: "parent-secret" } }, observer);
  assert.equal(first.prompt, "记一下：甲的独立标记 A_ONLY");
  assert.equal(first.session.systemPrompt, "原有角色规则");
  assert.ok(first.session.runtimeSystemPrompt?.includes("A_ONLY"));
  assert.ok(!first.session.runtimeSystemPrompt?.includes("B_ONLY"));
  assert.ok(!first.session.runtimeSystemPrompt?.includes(first.env.WAND_KNOWLEDGE_TOKEN!));
  assert.equal(storage.getSession("s_a")?.runtimeSystemPrompt, undefined);
  assert.equal(storage.getSession("s_a")?.systemPrompt, session.systemPrompt);
  assert.equal(storage.resolveEmployeeKnowledgeAccess(first.env.WAND_KNOWLEDGE_TOKEN!), "e_a");
  await execution.completion;
  assert.equal(storage.resolveEmployeeKnowledgeAccess(first.env.WAND_KNOWLEDGE_TOKEN!), null);
  storage.clearEmployeeKnowledge("e_a");
  let after = "";
  await startEmployeeKnowledgeRunner(storage, fakeRunner(ctx => { after = ctx.session.runtimeSystemPrompt!; }),
    { session, prompt: "回忆一下", env: {} }, observer).completion;
  assert.ok(!after.includes("A_ONLY"));
  let inherited!: StructuredRunnerContext;
  await startEmployeeKnowledgeRunner(storage, fakeRunner(ctx => { inherited = ctx; }),
    { session: snapshot("no-employee"), prompt: "记一下：不能乱归属", env: first.env }, observer).completion;
  assert.equal(inherited.env.WAND_KNOWLEDGE_TOKEN, undefined);
  assert.equal(inherited.env.WAND_KNOWLEDGE_DB, undefined);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 0);
});

test("all provider system channels and resumed no-flag providers receive live knowledge without repasting base rules", () => {
  for (const provider of ["claude", "qoder", "pi", "grok", "codex", "opencode", "gemini"] as SessionProvider[]) {
    const session = { ...snapshot("s", "e_a"), provider, runtimeSystemPrompt: "LIVE_KNOWLEDGE",
      messages: [{ role: "user", content: [] }, { role: "assistant", content: [] }] } as SessionSnapshot;
    if (["claude", "qoder", "pi", "grok"].includes(provider)) {
      assert.ok(systemPromptArgs(session).join(" ").includes("LIVE_KNOWLEDGE"));
      assert.equal(promptWithSystemFallback(session, "本轮用户输入"), "本轮用户输入");
    } else {
      const prompt = promptWithSystemFallback(session, "本轮用户输入");
      assert.ok(prompt.includes("LIVE_KNOWLEDGE"));
      assert.ok(!prompt.includes("原有角色规则"));
      assert.ok(prompt.endsWith("本轮用户输入"));
    }
  }
  assert.ok(buildSessionSystemPromptParts({ mode: "default", systemPrompt: "BASE", runtimeSystemPrompt: "LIVE" }, "").includes("LIVE"));
});

test("real manager accepts an employee memory request and supplies it to later/new sessions, never to another employee", async (t) => {
  const { root, storage } = setup(t);
  const contexts: StructuredRunnerContext[] = [];
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, undefined,
    { pi: fakeRunner(ctx => contexts.push(ctx)) });
  t.after(() => manager.dispose());
  const a = manager.createSession({ cwd: root, mode: "default", provider: "pi", employeeId: "e_a", systemPrompt: "BASE_A" });
  const b = manager.createSession({ cwd: root, mode: "default", provider: "pi", employeeId: "e_b", systemPrompt: "BASE_B" });
  await manager.sendMessage(a.id, "记一下：演示项目的发布窗口是周五");
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  await manager.sendMessage(b.id, "我的知识库里有什么？");
  assert.ok(!contexts.at(-1)!.session.runtimeSystemPrompt?.includes("演示项目"));
  const again = manager.createSession({ cwd: root, mode: "default", provider: "pi", employeeId: "e_a", systemPrompt: "BASE_A" });
  await manager.sendMessage(again.id, "发布窗口是什么？");
  assert.ok(contexts.at(-1)!.session.runtimeSystemPrompt?.includes("周五"));
  assert.equal(manager.get(a.id)?.systemPrompt, "BASE_A");
  assert.equal(manager.get(a.id)?.messages?.[0]?.content?.[0]?.text, "记一下：演示项目的发布窗口是周五");
  assert.equal(manager.get(a.id)?.runtimeSystemPrompt, undefined);
});

test("explicit/private employee knowledge never feeds the default habit learner", async (t) => {
  const { storage } = setup(t);
  recordUserMemory(storage, "session.prompt", "记一下：甲的私人事实");
  recordIterationPrompt(storage, { id: "s_explicit", cwd: "", employeeId: "e_a" }, "记一下：甲的私人事实");
  recordIterationPrompt(storage, { id: "s_a", cwd: "", employeeId: "e_a" }, "仅甲知道的工作细节和项目重点。");
  await whenUserMemorySettled(storage);
  await whenIterationPromptsSettled();
  assert.equal(storage.listUserMemoryEvents().length, 0);
  assert.equal(storage.latestIterationPromptForSession("s_explicit"), null);
});

test("employee knowledge HTTP namespace cannot be overridden by payload or used to delete another employee's entry", async (t) => {
  const { storage } = setup(t);
  const app = express(); app.use(express.json()); registerSiliconEmployeeRoutes(app, { storage });
  const server = createServer(app); await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const added = await fetch(`${base}/api/silicon-employees/e_a/knowledge`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ employeeId: "e_b", content: "甲的常用格式" }) });
  assert.equal(added.status, 201);
  const entry = await added.json() as { id: string; employeeId: string };
  assert.equal(entry.employeeId, "e_a");
  const wrong = await fetch(`${base}/api/silicon-employees/e_b/knowledge/${entry.id}`, { method: "DELETE" });
  assert.equal(wrong.status, 404);
  assert.equal(storage.countEmployeeKnowledge("e_a"), 1);
  assert.equal((await fetch(`${base}/api/silicon-employees/missing/knowledge`)).status, 404);
});
