import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../src/object-utils.js";
import { isRecord as modelIsRecord } from "../src/models/shared.js";
import { isRecord as storageIsRecord } from "../src/storage/mappers.js";
import { asRecord } from "../src/structured-content.js";
import { bodyObject } from "../src/server-request.js";
import { HttpError } from "../src/http-error.js";
import { collapseWhitespaceAndClip, clipAtWordBoundary } from "../src/text-utils.js";
import { parseTaskAgentCandidates, hasDuplicateTaskAgentCandidates } from "../src/task-agent-parsing.js";
import { parseSiliconEmployeeInput } from "../src/server-employee-routes.js";
import { parseAiTeamInput } from "../src/server-ai-team-routes.js";
import { listTeamDispatchCandidates } from "../src/team-dispatch.js";
import { rejectPendingRequests } from "../src/daemon-connection.js";
import { remainingCoreRequestBudget } from "../src/core-status-cli.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import type { WandStorage } from "../src/storage.js";

const AGENT: WandTaskAgent = {
  provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured",
};
const NOW = "2026-10-13T00:00:00.000Z";
function employeeInput(agents: unknown[]) {
  return { name: "候选员工", duty: "测试", prompt: "测试", agents };
}
function teamInput(agents: unknown[], extra: Record<string, unknown> = {}) {
  return { name: "候选团队", members: [
    { name: "负责人", duty: "计划", isLeader: true, agents, ...extra },
    { name: "执行者", duty: "实现", agents: [AGENT] },
  ] };
}

test("strict object guards retain public exports and existing instance semantics", () => {
  assert.equal(modelIsRecord, isRecord);
  assert.equal(storageIsRecord, isRecord);
  for (const value of [undefined, null, false, true, 0, 1, "", "x", [], () => {}]) {
    assert.equal(isRecord(value), false);
    assert.equal(asRecord(value), null);
    assert.throws(() => bodyObject(value), (error: unknown) => error instanceof HttpError
      && error.status === 400 && error.code === "invalid_request" && error.message === "请求体必须是对象。");
  }
  for (const value of [{}, new Date(NOW), Object.create(null), new (class Example {})()]) {
    assert.equal(isRecord(value), true);
    assert.equal(asRecord(value), value);
    assert.equal(bodyObject(value), value);
  }
});

test("strict guards do not swallow revoked-proxy errors", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.throws(() => isRecord(proxy), TypeError);
  assert.throws(() => asRecord(proxy), TypeError);
  assert.throws(() => bodyObject(proxy), TypeError);
});

test("single-line clipping preserves whitespace, ASCII and legacy small-limit semantics", () => {
  const legacy = (value: string, max: number) => {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
  };
  for (const value of ["", "  ab\n\t cd  ", "中文  摘要\n测试", "long ".repeat(40)]) {
    for (const max of [1, 2, 24, 120, 180]) assert.equal(collapseWhitespaceAndClip(value, max), legacy(value, max));
  }
  assert.equal(collapseWhitespaceAndClip(" a\n b\t c ", 20), "a b c");
  assert.equal(collapseWhitespaceAndClip("abcdef", 5), "abcd…");
  assert.equal(clipAtWordBoundary("hello world", 8), "hello");
  assert.equal(collapseWhitespaceAndClip("hello world", 8), "hello w…");
});

test("single-line clipping never creates an isolated surrogate from valid text", () => {
  for (const value of ["a".repeat(118) + "😀tail", "😀😀😀", "a😀tail", "汉😀字", "👩‍💻 long"]) {
    assert.equal(value.isWellFormed(), true);
    for (const max of [2, 3, 4, 24, 120]) {
      const result = collapseWhitespaceAndClip(value, max);
      assert.equal(result.isWellFormed(), true, `${max}: ${JSON.stringify(result)}`);
      assert.ok(result.length <= max);
      assert.equal(/[\r\n\t]/.test(result), false);
    }
  }
  assert.equal(collapseWhitespaceAndClip("a".repeat(118) + "😀tail", 120), "a".repeat(118) + "…");
  assert.equal(collapseWhitespaceAndClip("😀x", 2), "…");
  assert.equal(collapseWhitespaceAndClip("😀x", 3), "😀x");
});

test("team dispatch uses the common Unicode-safe clipping in its actual projection", () => {
  const employee: SiliconEmployee = {
    id: "e_merge_test", name: "测试员工", duty: "a".repeat(118) + "😀tail", prompt: "test", avatar: "",
    agents: [AGENT], createdAt: NOW, updatedAt: NOW,
  };
  const storage = { listSiliconEmployees: () => [employee] } as unknown as WandStorage;
  const candidates = listTeamDispatchCandidates(storage);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.duty, "a".repeat(118) + "…");
  assert.equal(candidates[0]!.duty.isWellFormed(), true);
  assert.equal(employee.duty, "a".repeat(118) + "😀tail", "presentation does not rewrite employee data");
});

test("candidate kernel preserves order, literal identity and per-item policy timing", () => {
  const sdk = { ...AGENT, provider: "pi", engine: "sdk" };
  const candidates = parseTaskAgentCandidates([AGENT, { ...AGENT, model: "configured" }, sdk]);
  assert.deepEqual(candidates.map((candidate) => candidate.model), ["default", "configured", "default"]);
  assert.equal(candidates[2]!.engine, "sdk");
  assert.equal(hasDuplicateTaskAgentCandidates(candidates), false);
  assert.equal(hasDuplicateTaskAgentCandidates([candidates[0]!, candidates[0]!]), true);
  assert.equal(hasDuplicateTaskAgentCandidates([candidates[0]!, { ...candidates[0]!, engine: "cli" }]), true);
  assert.equal(hasDuplicateTaskAgentCandidates([{ ...AGENT, provider: "pi" }, candidates[2]!]), false);
  assert.throws(() => parseTaskAgentCandidates([]), /至少需要一个执行候选/);
  assert.throws(() => parseTaskAgentCandidates(Array(5).fill(AGENT)), /最多 4 个执行候选/);
  assert.throws(() => parseTaskAgentCandidates([{ ...AGENT, kind: "pty" }, { provider: "invalid" }], (candidate) => {
    if (candidate.kind !== "structured") throw new Error("first-item-policy");
  }), /first-item-policy/);
});

test("employee and team wrappers retain their different policies and error precedence", () => {
  const pty = { ...AGENT, kind: "pty" };
  assert.throws(() => parseSiliconEmployeeInput(employeeInput([pty, pty]), null, NOW), /硅基员工只支持结构化会话/);
  assert.throws(() => parseSiliconEmployeeInput(employeeInput([pty, { provider: "invalid" }]), null, NOW), /硅基员工只支持结构化会话/);
  assert.throws(() => parseSiliconEmployeeInput(employeeInput([AGENT, AGENT, { provider: "invalid" }]), null, NOW), /请选择有效的 CLI 工具/);
  assert.throws(() => parseSiliconEmployeeInput(employeeInput([AGENT, AGENT]), null, NOW), (error: unknown) =>
    error instanceof HttpError && error.message === "执行候选存在重复。");
  assert.throws(() => parseAiTeamInput(teamInput([AGENT, AGENT]), null, NOW), (error: unknown) =>
    error instanceof HttpError && error.message === "成员「负责人」的执行候选重复。");
  assert.throws(() => parseAiTeamInput(teamInput([]), null, NOW), /成员「负责人」：至少需要一个执行候选/);
  assert.throws(() => parseAiTeamInput(teamInput([{ provider: "invalid" }]), null, NOW), /成员「负责人」：请选择有效的 CLI 工具/);
  const parsed = parseAiTeamInput(teamInput([pty]), null, NOW);
  assert.equal(parsed.members[0]!.agents[0]!.kind, "pty", "legacy free members retain PTY support");
  assert.deepEqual(parsed.members[0]!.agent, parsed.members[0]!.agents[0]);
  const legacy = parseAiTeamInput({ name: "旧格式", members: [
    { name: "负责人", isLeader: true, agent: AGENT }, { name: "执行者", agent: AGENT },
  ] }, null, NOW);
  assert.deepEqual(legacy.members[0]!.agents, [AGENT]);
});

test("pending cleanup cancels timers, rejects in insertion order and clears only this generation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const failure = new Error("disconnected");
  const pending = new Map<number, { timer: NodeJS.Timeout; reject(error: Error): void; method: string }>();
  for (const id of [2, 1]) {
    pending.set(id, { timer: setTimeout(() => events.push(`expired:${id}`), 50), method: "test",
      reject: (error) => { assert.equal(error, failure); events.push(`rejected:${id}`); } });
  }
  rejectPendingRequests(pending, failure);
  assert.deepEqual(events, ["rejected:2", "rejected:1"]);
  assert.equal(pending.size, 0);
  t.mock.timers.tick(100);
  assert.deepEqual(events, ["rejected:2", "rejected:1"], "no expired callback after rejection");
  rejectPendingRequests(pending, failure);
  assert.deepEqual(events, ["rejected:2", "rejected:1"], "repeated clear does not reject old entries again");
  pending.set(3, { timer: setTimeout(() => events.push("new-expired"), 50), method: "new", reject: () => events.push("new-rejected") });
  t.mock.timers.tick(50);
  assert.equal(events.at(-1), "new-expired", "new generation is not invalidated by prior cleanup");
});

test("Core request budgets keep the original deadline, 5s cap, Infinity and fail-closed error", (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(remainingCoreRequestBudget(Infinity), 5_000);
  assert.equal(remainingCoreRequestBudget(50_000), 5_000);
  assert.equal(remainingCoreRequestBudget(1_250), 250);
  now = 1_200;
  assert.equal(remainingCoreRequestBudget(1_250), 50, "does not restart the original timeout");
  now = 1_250;
  assert.throws(() => remainingCoreRequestBudget(1_250), /超时.*未停止.*取消重启/);
  assert.throws(() => remainingCoreRequestBudget(1_000), /超时.*未停止.*取消重启/);
});
