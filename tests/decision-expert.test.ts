import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { EmployeeCandidateRejected } from "../src/employee-text.ts";
import { WandStorage } from "../src/storage.ts";
import { decisionExpertDefinition } from "../src/decision-expert-employee.ts";
import { DECISION_EXPERT_ID, DECISION_EXPERT_KEY, WAND_LOCAL_DECISION_MODEL } from "../src/decision-expert-identity.ts";
import { isBuiltinSiliconEmployee, siliconEmployeeTags, SYSTEM_EMPLOYEE_KEY, DEFAULT_EMPLOYEE_KEY } from "../src/ai-team-types.ts";
import { OPENROUTER_FREE_SELECTOR } from "../src/openrouter-free-selection.ts";
import { assessDecisionHardware } from "../src/decision-hardware.ts";
import { DecisionExpertService } from "../src/decision-expert-service.ts";
import { parseDecisionRequest, parseDecisionResult } from "../src/decision-types.ts";
import { parseSystemEmployeeAgents, parseSiliconEmployeeInput } from "../src/server-employee-routes.ts";
import { selectEmployeeCandidate } from "../src/silicon-employee-dispatch.ts";

const gib = 1024 ** 3;
const hardware = () => assessDecisionHardware({ platform: "darwin", arch: "arm64", memoryBytes: 16 * gib, availableBytes: gib, cpuCount: 8, metal: true });
const value = { state: "Public synthetic evidence", questions: { route: { type: "choice", instructions: "Choose", criteria: ["a", "b"] } } };
const answers = { route: { type: "choice", choice: "a", probabilities: { a: .8, b: .2 } } };
const local = () => parseDecisionResult({ answers, usage: { input_tokens: 10, output_tokens: 0, truncated: false } }, parseDecisionRequest(value));
function runtime(extras: any = {}) {
  const employee = decisionExpertDefinition(new Date().toISOString());
  let localCalls = 0, freeCalls = 0;
  const service = new DecisionExpertService({ employee: () => employee,
    local: { status: () => ({ enabled: true, supported: true, configured: true, state: "ready", queued: 0, completed: 0, failed: 0, experimental: true }),
      evaluate: async () => { localCalls += 1; return local(); } },
    free: { status: () => ({ configured: true, modelCount: 1 }) as any, resolveForCall: async () => { throw Error("no real network in tests"); } },
    config: defaultConfig(), hardware, generate: async () => { freeCalls += 1; return { answers, model: "wand-openrouter-free/test:free", inputTokens: 12, outputTokens: 8 }; }, ...extras });
  return { service, employee, counts: () => ({ localCalls, freeCalls }) };
}

test("decision expert seeds once, locks identity and preserves reordered/custom call chains", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-expert-")), storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const employee = storage.ensureDecisionExpertEmployee();
  assert.equal(employee.id, DECISION_EXPERT_ID); assert.equal(employee.name, "决策专家"); assert.equal(employee.systemKey, DECISION_EXPERT_KEY);
  assert.deepEqual(employee.agents.map(agent => agent.model), [WAND_LOCAL_DECISION_MODEL, OPENROUTER_FREE_SELECTOR]);
  assert.equal(isBuiltinSiliconEmployee(employee), true); assert.deepEqual(siliconEmployeeTags(employee), ["系统用户"]);
  assert.throws(() => parseSystemEmployeeAgents({ name: "fake", agents: employee.agents }, employee), /不可修改/);
  const reordered = { ...employee, agents: [...employee.agents].reverse() }; storage.saveSiliconEmployee(reordered);
  assert.deepEqual(storage.ensureDecisionExpertEmployee().agents, reordered.agents);
  assert.equal(parseSystemEmployeeAgents({ agents: [{ ...employee.agents[0], model: "configured-model" }] }, employee)[0]?.model, "configured-model");
  assert.equal(parseSystemEmployeeAgents({ agents: [{ ...employee.agents[0], engine: "cli", model: "cli-model" }] }, employee)[0]?.engine ?? "cli", "cli");
  assert.equal(parseSystemEmployeeAgents({ agents: [employee.agents[1]] }, employee)[0]?.model, OPENROUTER_FREE_SELECTOR);
});

test("hardware checks distinguish platform, Metal, total RAM and CPU without falsely rejecting reclaimable Mac cache", () => {
  assert.equal(hardware().suitable, true);
  const base = { platform: "darwin", arch: "arm64", memoryBytes: 16 * gib, availableBytes: 0, cpuCount: 8 };
  for (const item of [{ ...base, platform: "linux" }, { ...base, metal: false }, { ...base, memoryBytes: 4 * gib }, { ...base, cpuCount: 2 }]) {
    const result = assessDecisionHardware(item); assert.equal(result.suitable, false); assert.match(result.message, /决策专家/);
  }
  assert.match(assessDecisionHardware({ ...base, memoryBytes: 4 * gib }).message, /性能不够/);
});

test("bounded suggestions prefer the real local model and carry accurate employee/source identity", async () => {
  const h = runtime(); const result = await h.service.evaluate(value, "test");
  assert.equal(result.runtime, "laya-mlx"); assert.equal(result.executor?.source, "local"); assert.equal(result.executor?.employeeId, DECISION_EXPERT_ID);
  assert.deepEqual(h.counts(), { localCalls: 1, freeCalls: 0 });
});

test("weak machine never starts local inference, shows configuration advice and uses configured free backup", async () => {
  const h = runtime({ hardware: () => assessDecisionHardware({ platform: "linux", arch: "x64", memoryBytes: 2 * gib, availableBytes: gib, cpuCount: 2 }) });
  assert.match(h.service.status().notice!, /决策专家/);
  const result = await h.service.evaluate(value, "test");
  assert.equal(result.runtime, "decision-expert"); assert.equal(result.executor?.source, "free-group"); assert.equal(result.usage.output_tokens, 8);
  assert.deepEqual(h.counts(), { localCalls: 0, freeCalls: 1 });
});

test("an explicitly configured model is used, while bad output is not replayed", async () => {
  const h = runtime({ hardware: () => ({ ...hardware(), suitable: false }) });
  h.employee.agents = [{ ...h.employee.agents[1]!, model: "paid-model" }];
  assert.equal((await h.service.evaluate(value, "test")).executor?.source, "sdk");
  assert.equal(h.counts().freeCalls, 1);
  const bad = runtime({ hardware: () => ({ ...hardware(), suitable: false }), generate: async () => ({ answers: {}, model: "test:free", inputTokens: 1, outputTokens: 1 }) });
  await assert.rejects(bad.service.evaluate(value, "test"), /结果无效/);
});

test("expert deadline and cancellation stop the free generator and release its active slot", async () => {
  let generated = 0;
  const h = runtime({ hardware: () => ({ ...hardware(), suitable: false }), timeoutMs: 25,
    generate: (_agent: any, _request: any, _employee: any, signal: AbortSignal) => new Promise((_resolve, reject) => {
      generated += 1; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
  await assert.rejects(h.service.evaluate(value, "test"), (error: any) => error.code === "TIMEOUT");
  assert.equal(h.service.status().queued, 0);
  const abort = new AbortController(), pending = h.service.evaluate(value, "test", abort.signal); abort.abort();
  await assert.rejects(pending, (error: any) => error.code === "CANCELLED");
  assert.equal(h.service.status().queued, 0); assert.equal(generated, 2);
});

test("ordinary private chat does not pass LAYA selector to a fake chat provider", () => {
  const h = runtime(); assert.equal(selectEmployeeCandidate(h.employee, () => true).agent.model, OPENROUTER_FREE_SELECTOR);
  h.employee.agents = [h.employee.agents[0]!]; assert.throws(() => selectEmployeeCandidate(h.employee), /LAYA 仅支持有界决策/);
});

const cliCandidate = { provider: "codex", engine: "cli", model: "configured-codex", kind: "structured", mode: "default", thinkingEffort: "off" } as const;
const sdkCandidate = { provider: "pi", engine: "sdk", model: "configured-provider/configured-sdk", kind: "structured", mode: "default", thinkingEffort: "off" } as const;

test("decision CLI and SDK use configured order, and unavailable adapters accept no request", async () => {
  const prepared: string[] = [], called: string[] = [];
  const h = runtime({ generate: undefined, prepare: async (agent: any, request: any) => {
    prepared.push(agent.model); assert.match(request.system, /不得执行操作/);
    assert.deepEqual(JSON.parse(request.prompt), parseDecisionRequest(value));
    if (agent.engine === "cli") throw Error("not installed");
    return async () => { called.push(agent.model); return JSON.stringify({ answers }); };
  } });
  h.employee.agents = [cliCandidate, sdkCandidate];
  const snapshot = JSON.stringify(h.employee.agents);
  const result = await h.service.evaluate(value, "test");
  assert.equal(result.executor?.candidate, 1); assert.equal(result.executor?.source, "sdk");
  assert.deepEqual(prepared, [cliCandidate.model, sdkCandidate.model]); assert.deepEqual(called, [sdkCandidate.model]);
  assert.equal(result.usage.available, false); assert.equal(JSON.stringify(h.employee.agents), snapshot);
});

test("decision follows reordered CLI success without appending global defaults", async () => {
  const calls: string[] = [];
  const h = runtime({ generate: undefined, prepare: async (agent: any) => async () => { calls.push(agent.model); return JSON.stringify({ answers }); } });
  h.employee.agents = [cliCandidate, sdkCandidate];
  const result = await h.service.evaluate(value, "test");
  assert.equal(result.executor?.source, "cli"); assert.equal(result.executor?.candidate, 0);
  assert.deepEqual(calls, [cliCandidate.model]);
});

test("decision only verified pre-execution refusal advances the ordered chain", async () => {
  const calls: string[] = [];
  const h = runtime({ generate: undefined, prepare: async (agent: any) => async () => {
    calls.push(agent.model);
    if (agent.engine === "cli") throw new EmployeeCandidateRejected({ kind: "authentication", delivery: "rejected", retryable: true });
    return JSON.stringify({ answers });
  } });
  h.employee.agents = [cliCandidate, sdkCandidate];
  assert.equal((await h.service.evaluate(value, "test")).executor?.candidate, 1);
  assert.deepEqual(calls, [cliCandidate.model, sdkCandidate.model]);
});

for (const failure of ["unknown delivery", "invalid output"]) test(`decision stops after ${failure} without retrying the next tool`, async () => {
  let calls = 0;
  const h = runtime({ generate: undefined, prepare: async () => async () => {
    calls += 1;
    if (failure === "unknown delivery") throw Error("unknown");
    return JSON.stringify({ answers: {} });
  } });
  h.employee.agents = [cliCandidate, sdkCandidate];
  await assert.rejects(h.service.evaluate(value, "test"), (error: any) => error.code === "EXECUTION_FAILED");
  assert.equal(calls, 1);
});

test("decision all unavailable returns clear error, with no model calls or config changes", async () => {
  let checks = 0;
  const h = runtime({ generate: undefined, prepare: async () => { checks += 1; throw Error("unavailable"); } });
  h.employee.agents = [cliCandidate, sdkCandidate];
  await assert.rejects(h.service.evaluate(value, "test"), (error: any) => error.code === "CONFIGURATION_REQUIRED");
  assert.equal(checks, 2); assert.equal(h.service.status().queued, 0);
});

test("decision deadline bounds adapters ignoring abort, while caller cancel releases its slot", async () => {
  const h = runtime({ timeoutMs: 25, generate: undefined, prepare: async () => async () => new Promise(() => {}) });
  h.employee.agents = [sdkCandidate];
  await assert.rejects(h.service.evaluate(value, "test"), (error: any) => error.code === "TIMEOUT");
  assert.equal(h.service.status().queued, 0);
  const abort = new AbortController(), pending = h.service.evaluate(value, "test", abort.signal); abort.abort();
  await assert.rejects(pending, (error: any) => error.code === "CANCELLED");
  assert.equal(h.service.status().queued, 0);
});

test("decision keeps bounded request and concurrency limits with configurable tools", async () => {
  let calls = 0;
  const h = runtime({ generate: undefined, prepare: async () => async () => { calls += 1; return new Promise(() => {}); } });
  h.employee.agents = [sdkCandidate];
  await assert.rejects(h.service.evaluate({ ...value, questions: {} }, "test"), (error: any) => error.code === "INVALID_REQUEST");
  assert.equal(calls, 0);
  const abort = new AbortController();
  const pending = Array.from({ length: 8 }, () => h.service.evaluate(value, "test", abort.signal));
  await assert.rejects(h.service.evaluate(value, "test"), (error: any) => error.code === "BUSY");
  abort.abort(); await Promise.allSettled(pending); assert.equal(h.service.status().queued, 0);
});

test("all employee roles share tool/model validation and retain legacy single-agent config", () => {
  const base = decisionExpertDefinition(new Date().toISOString());
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi", "gemini"] as const) {
    const configured = { provider, model: "explicit-configured-model", kind: "structured", engine: "cli", thinkingEffort: "off", mode: "default" };
    const ordinary = parseSiliconEmployeeInput({ name: "ordinary", duty: "", prompt: "", agent: configured }, null, "now");
    for (const systemKey of [SYSTEM_EMPLOYEE_KEY, DEFAULT_EMPLOYEE_KEY, DECISION_EXPERT_KEY, "wand-speech-polisher"]) {
      const role = { ...base, systemKey };
      const parsed = parseSystemEmployeeAgents({ agents: [configured] }, role);
      assert.deepEqual(parsed, ordinary.agents);
      assert.equal(parsed[0]?.provider, provider); assert.equal(parsed[0]?.model, configured.model);
      assert.throws(() => parseSystemEmployeeAgents({ agents: [configured, configured] }, role), /重复/);
      assert.throws(() => parseSystemEmployeeAgents({ agents: [] }, role), /至少/);
      assert.throws(() => parseSystemEmployeeAgents({ agents: Array(5).fill(configured) }, role), /最多/);
    }
  }
  assert.throws(() => parseSystemEmployeeAgents({ agents: [{ ...sdkCandidate, provider: "codex" }] }, base), /仅支持结构化会话/);
  assert.throws(() => parseSystemEmployeeAgents({ agents: [{ ...cliCandidate, kind: "pty" }] }, base), /硅基员工只支持结构化/);
});
