import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { DecisionService } from "../src/decision-service.js";
import { AUTO_ASSIGN_LABEL, AUTO_ASSIGN_SELECTOR, defaultModelGroupSelector, findModelGroup,
  isAutoAssignSelector, modelGroupSelector, normalizeModelGroups, resolveModelGroupModels, type ModelGroup } from "../src/model-groups.js";
import { parseGroupChoice, resolveAutoAssign } from "../src/model-auto-assign.js";
import { ModelCatalogService, withConfiguredDefaultModelLabels } from "../src/models.js";
import { SESSION_PROVIDERS } from "../src/provider-catalog.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { StructuredRunnerAdapter, StructuredRunnerObserver, StructuredRunnerResult } from "../src/structured-runner.js";
import type { SessionSnapshot } from "../src/types.js";

const groups = (...names: string[]): ModelGroup[] => names.map((name, index) => ({
  id: `g${index}`, provider: "pi" as const, name, models: [`${name}-first`, `${name}-second`],
}));

/** 决策替身：按 label 打分，模拟「模型有明确偏好」与「模型拿不准」两种结果。 */
function evaluateReturning(choice: string | null, probability: number) {
  return async (value: unknown) => {
    const request = value as { questions: Record<string, { type: string; criteria?: Record<string, string> }> };
    const answers: Record<string, Record<string, unknown>> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === "choice") {
        const labels = Object.keys(question.criteria ?? {});
        const picked = choice && labels.includes(choice) ? choice : labels[0]!;
        answers[key] = { type: "choice", confidence: 1, choice: picked,
          probabilities: Object.fromEntries(labels.map((label) => [label, label === picked ? probability : probability === 1 ? 0 : (1 - probability) / Math.max(1, labels.length - 1)])) };
      } else {
        answers[key] = { type: "noul", noul: question.instructions?.includes(choice ?? "") ? probability : 0.1 };
      }
    }
    return { model: "test", answers, usage: { input_tokens: 1, output_tokens: 0, truncated: false },
      experimental: true, runtime: "laya-mlx" } as never;
  };
}

test("目录为每个工具提供紧随默认项的「智能分配」，默认模型指向它时标签正确", () => {
  const catalog = new ModelCatalogService(() => ({ modelGroups: () => groups("编程分组") }));
  const snapshot = catalog.snapshot() as unknown as Record<string, Array<{ id: string; label: string }>>;
  for (const provider of SESSION_PROVIDERS) {
    const key = provider === "claude" ? "models" : `${provider}Models`;
    const list = snapshot[key]!;
    assert.equal(list[0]!.id, "default", `${provider} 默认项仍在最前`);
    assert.equal(list[1]!.id, AUTO_ASSIGN_SELECTOR, `${provider} 紧随其后提供智能分配`);
    assert.equal(list[1]!.label, AUTO_ASSIGN_LABEL);
  }
  assert.equal(list1Label(snapshot, AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_LABEL);
  const labeled = withConfiguredDefaultModelLabels({ piModels: [{ id: "default", label: "跟随默认" },
    { id: AUTO_ASSIGN_SELECTOR, label: AUTO_ASSIGN_LABEL }] }, { pi: AUTO_ASSIGN_SELECTOR });
  assert.equal(labeled.piModels[0]!.label, `跟随服务端默认（${AUTO_ASSIGN_LABEL}）`);
});

function list1Label(snapshot: Record<string, Array<{ id: string; label: string }>>, id: string): string {
  return snapshot.piModels!.find((model) => model.id === id)?.label ?? "";
}

test("智能分配是明确选择：按名字/选择器都保留，落地同步场景时按默认分组解析", () => {
  const configured = normalizeModelGroups(groups("编程分组"));
  assert.equal(isAutoAssignSelector(AUTO_ASSIGN_SELECTOR), true);
  assert.equal(isAutoAssignSelector(`${AUTO_ASSIGN_SELECTOR} `), true);
  assert.equal(isAutoAssignSelector("default"), false);
  assert.equal(defaultModelGroupSelector(configured, "pi", AUTO_ASSIGN_SELECTOR), AUTO_ASSIGN_SELECTOR,
    "不能把智能分配提前换成某个分组");
  assert.equal(findModelGroup(configured, "pi", AUTO_ASSIGN_SELECTOR)?.name, "编程分组",
    "同步落地时智能分配等价于默认分组");
  assert.deepEqual(resolveModelGroupModels(configured, "pi", AUTO_ASSIGN_SELECTOR), ["编程分组-first", "编程分组-second"]);
  assert.deepEqual(resolveModelGroupModels([], "pi", AUTO_ASSIGN_SELECTOR), [""], "没有分组时用工具自己的默认模型");
  assert.throws(() => normalizeModelGroups([{ id: "a", provider: "pi", name: "组", models: [AUTO_ASSIGN_SELECTOR] }]),
    /具体模型 ID/);
});

test("只有一个分组时直接用它，不需要任何判断", async () => {
  let calls = 0;
  const result = await resolveAutoAssign({ provider: "pi", prompt: "写一个快排", groups: groups("唯一分组"),
    evaluate: async () => { calls++; throw new Error("不该被调用"); } });
  assert.equal(result.strategy, "only");
  assert.equal(result.group?.name, "唯一分组");
  assert.equal(result.selector, modelGroupSelector({ id: "g0", provider: "pi" }));
  assert.equal(calls, 0);
});

test("没有分组、没有提示词、判断失败都退化成默认分组，不抛错", async () => {
  assert.equal((await resolveAutoAssign({ provider: "pi", prompt: "任务", groups: [] })).selector, "");
  const noPrompt = await resolveAutoAssign({ provider: "pi", prompt: "   ",
    groups: normalizeModelGroups(groups("A", "B")),
    evaluate: async () => { throw new Error("不该被调用"); } });
  assert.equal(noPrompt.strategy, "default");
  assert.equal(noPrompt.group?.name, "A", "默认分组按默认名字/首个分组回落");
  const failed = await resolveAutoAssign({ provider: "pi", prompt: "任务", groups: groups("A", "B"),
    evaluate: async () => { throw new Error("决策不可用"); } });
  assert.equal(failed.strategy, "default");
  assert.equal(failed.group?.name, "A");
});

test("AI 优先：能给出唯一分组名就用它，不再打扰本地模型", async () => {
  const two = normalizeModelGroups(groups("编程分组", "写作分组"));
  let localCalls = 0;
  const result = await resolveAutoAssign({ provider: "pi", prompt: "实现一个 LRU 缓存", groups: two, ai: {},
    aiCall: async () => "编程分组",
    evaluate: async () => { localCalls++; throw new Error("不该被调用"); } });
  assert.equal(result.strategy, "ai");
  assert.equal(result.group?.name, "编程分组");
  assert.equal(result.calls, 1);
  assert.equal(localCalls, 0);
  const undecided = await resolveAutoAssign({ provider: "pi", prompt: "实现一个 LRU 缓存", groups: two, ai: {},
    aiCall: async () => "-", evaluate: evaluateReturning("写作分组", 0.9) });
  assert.equal(undecided.strategy, "local", "AI 说不清时回退本地决策");
  assert.equal(undecided.group?.name, "写作分组");
});

test("本地决策：正反两种选项顺序一致才算结论，拿不准就留给下一层", async () => {
  const two = groups("编程分组", "写作分组");
  const picked = await resolveAutoAssign({ provider: "pi", prompt: "总结这段文字", groups: two,
    evaluate: evaluateReturning("写作分组", 0.9) });
  assert.equal(picked.strategy, "local");
  assert.equal(picked.group?.name, "写作分组");
  assert.equal(picked.calls, 2);
  assert.equal(picked.probability, 0.9);
  const unsure = await resolveAutoAssign({ provider: "pi", prompt: "随便", groups: two,
    evaluate: evaluateReturning("写作分组", 0.2) });
  assert.equal(unsure.strategy, "default");
  assert.equal(unsure.group?.name, "编程分组");
});

test("位置偏好模型（照抄最后一个选项）不算结论", async () => {
  const two = normalizeModelGroups(groups("编程分组", "写作分组"));
  const positional = async (value: unknown) => {
    const request = value as { questions: Record<string, { criteria?: Record<string, string> }> };
    const labels = Object.keys(request.questions.group?.criteria ?? {});
    return { model: "test", answers: { group: { type: "choice", confidence: 1, choice: labels[labels.length - 1]!,
      probabilities: Object.fromEntries(labels.map((label) => [label, label === labels[labels.length - 1] ? 0.9 : 0.05])) } },
      usage: { input_tokens: 1, output_tokens: 0, truncated: false }, experimental: true, runtime: "laya-mlx" } as never;
  };
  const nothing = await resolveAutoAssign({ provider: "pi", prompt: "实现一个 LRU 缓存", groups: two, evaluate: positional });
  assert.equal(nothing.strategy, "default", "两种顺序给出不同分组时必须放弃这一次本地结论");
  const calls: string[] = [];
  const viaAi = await resolveAutoAssign({ provider: "pi", prompt: "实现一个 LRU 缓存", groups: two, evaluate: positional,
    ai: {}, aiCall: async (request) => { calls.push(request.prompt ?? ""); return "编程分组"; } });
  assert.equal(viaAi.strategy, "ai");
  assert.equal(viaAi.group?.name, "编程分组");
  assert.equal(viaAi.calls, 1);
  assert.equal(calls.length, 1);
});

test("候选超过本地一次比较上限时只用 AI；AI 说不清就用默认分组", async () => {
  const many = normalizeModelGroups(groups("一", "二", "三", "四", "五", "六"));
  let localCalls = 0;
  const result = await resolveAutoAssign({ provider: "pi", prompt: "重构一大段代码", groups: many,
    evaluate: async () => { localCalls++; throw new Error("不该被调用"); }, ai: {},
    aiCall: async () => " 五。 " });
  assert.equal(localCalls, 0);
  assert.equal(result.strategy, "ai");
  assert.equal(result.group?.name, "五");
  const unclear = await resolveAutoAssign({ provider: "pi", prompt: "重构一大段代码", groups: many, ai: {},
    aiCall: async () => " 按情况选择 " });
  assert.equal(unclear.strategy, "default");
  assert.equal(unclear.group?.name, "一");
});

test("真实决策 worker：位置偏好被正反顺序挡下，AI 说了才算（AI 优先）", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-auto-assign-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const service = new DecisionService({ enabled: true, pythonPath: process.execPath, modelPath: root },
    { workerPath: resolve("tests/fixtures/decision-worker.mjs"), timeoutMs: 2000, idleMs: 1000, supported: () => true });
  t.after(() => { service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const two = normalizeModelGroups(groups("编程分组", "写作分组"));
  const evaluate = (value: unknown, caller: string, signal?: AbortSignal) => service.evaluate(value, caller, signal);
  // fixture worker 永远选第一个选项：正反顺序必然给出不同分组，所以它不构成结论。
  const rejected = await resolveAutoAssign({ provider: "pi", prompt: "把这段脚本改写成 TypeScript", groups: two, evaluate });
  assert.equal(rejected.strategy, "default");
  const decided = await resolveAutoAssign({ provider: "pi", prompt: "把这段脚本改写成 TypeScript", groups: two,
    evaluate, ai: {}, aiCall: async () => "编程分组" });
  assert.equal(decided.strategy, "ai");
  assert.equal(decided.group?.name, "编程分组");
  assert.equal(decided.calls, 1);
});

const observer: StructuredRunnerObserver = { isActive: () => true, onUpdate() {} };
const state = (model = "first"): StructuredRunnerResult["state"] => ({ blocks: [], result: "", sessionId: null, model });
const success = (): StructuredRunnerResult => ({ state: { ...state("second"), result: "ok",
  blocks: [{ type: "text", text: "ok" }] }, exitCode: 0, signal: null, stderr: "", primaryError: null, inputAccepted: true });

function session(model: string | null): SessionSnapshot {
  return { id: "auto-session", provider: "pi", sessionKind: "structured", command: "pi", cwd: process.cwd(),
    mode: "managed", status: "idle", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, output: "",
    archived: false, archivedAt: null, claudeSessionId: null, selectedModel: model, messages: [] } as SessionSnapshot;
}

test("会话第一轮按提示词钉住分组，之后不再重复判断；终端与一次性调用退化成默认分组", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-auto-assign-session-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const two = normalizeModelGroups(groups("编程分组", "写作分组"));
  const config = { ...defaultConfig(), modelGroups: two };
  const seen: string[] = [];
  let decisions = 0;
  const runner: StructuredRunnerAdapter = { start(context) {
    seen.push(context.session.selectedModel!);
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve({ ...success(),
      state: { ...success().state, model: context.session.selectedModel! } }) };
  } };
  storage.saveSession({ ...session(AUTO_ASSIGN_SELECTOR), runner: "pi-cli-json" });
  const manager = new StructuredSessionManager(storage, config, null, { pi: runner }, undefined, () => null, undefined,
    () => async (value: unknown) => {
      decisions++;
      return await evaluateReturning("写作分组", 0.9)(value);
    });
  try {
    const first = await manager.sendMessage("auto-session", "把这段英文润色一下");
    assert.equal(first.selectedModel, modelGroupSelector({ id: "g1", provider: "pi" }));
    assert.equal(first.structuredState?.model, "写作分组-first", "执行态记录真正用的模型");
    assert.deepEqual(seen, ["写作分组-first"]);
    assert.equal(storage.loadSessions()[0]!.selectedModel, modelGroupSelector({ id: "g1", provider: "pi" }));
    const second = await manager.sendMessage("auto-session", "再短一点");
    assert.equal(second.selectedModel, modelGroupSelector({ id: "g1", provider: "pi" }), "第二轮沿用同一分组");
    assert.equal(decisions, 2, "第一轮做了两次（正反顺序）判断，之后不再重复判断");
    assert.deepEqual(seen, ["写作分组-first", "写作分组-first"]);
  } finally { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("结算期间的新输入排队而不是另起一轮，停止后不再启动", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-auto-assign-queue-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), modelGroups: normalizeModelGroups(groups("编程分组", "写作分组")) };
  let started = 0;
  let release: (() => void) | null = null;
  const runner: StructuredRunnerAdapter = { start(context) {
    started++;
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve({ ...success(),
      state: { ...success().state, model: context.session.selectedModel! } }) };
  } };
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  storage.saveSession({ ...session(AUTO_ASSIGN_SELECTOR), runner: "pi-cli-json" });
  const manager = new StructuredSessionManager(storage, config, null, { pi: runner }, undefined, () => null, undefined,
    () => async (value: unknown) => { await gate; return await evaluateReturning("写作分组", 0.9)(value); });
  try {
    const first = manager.sendMessage("auto-session", "第一条");
    await new Promise((resolveTick) => setImmediate(resolveTick));
    const second = manager.sendMessage("auto-session", "第二条");
    const queued = storage.loadSessions()[0]!;
    assert.deepEqual(queued.queuedMessages, ["第二条"], "结算窗口内的输入必须排队");
    assert.equal(started, 0, "结算完成前没有 runner");
    release!();
    await first;
    // 队列在回合结束时经 setImmediate 起下一轮。
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    await second;
    assert.equal(started, 2, "第二条在第一轮结束后作为下一轮启动");
    assert.equal(manager.get("auto-session")!.queuedMessages?.length ?? 0, 0);
  } finally { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("结算还没回来就点停止：不再启动那一轮", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-auto-assign-stop-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), modelGroups: normalizeModelGroups(groups("编程分组", "写作分组")) };
  let started = 0;
  const runner: StructuredRunnerAdapter = { start() {
    started++;
    return { args: [], pid: null, spawnedAt: "", interrupt() {}, completion: Promise.resolve(success()) };
  } };
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  storage.saveSession({ ...session(AUTO_ASSIGN_SELECTOR), runner: "pi-cli-json" });
  const manager = new StructuredSessionManager(storage, config, null, { pi: runner }, undefined, () => null, undefined,
    () => async (value: unknown) => { await gate; return await evaluateReturning("写作分组", 0.9)(value); });
  try {
    const pending = manager.sendMessage("auto-session", "第一条");
    await new Promise((resolveTick) => setImmediate(resolveTick));
    manager.stop("auto-session");
    release!();
    await pending;
    await new Promise((resolveTick) => setImmediate(resolveTick));
    assert.equal(started, 0, "停止后不启动被取消的回合");
    assert.equal(manager.get("auto-session")!.selectedModel, AUTO_ASSIGN_SELECTOR, "取消不改写会话选择");
  } finally { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});
