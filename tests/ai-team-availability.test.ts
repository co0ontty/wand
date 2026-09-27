import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_TEAM_STARTUP_WINDOW_MS,
  classifyCandidateFailure,
  classifyStartupFailure,
  isDegradableWorkFailure,
  isModelUnknownBeforeDispatch,
  isSessionGoneStatus,
  type WorkFailureInput,
} from "../src/ai-team-availability.js";
import type { WandTaskAgent } from "../src/task-types.js";

const structuredAgent: WandTaskAgent = {
  provider: "claude",
  model: "some-model",
  thinkingEffort: "off",
  mode: "full-access",
  kind: "structured",
};

function degradableInput(overrides: Partial<WorkFailureInput> = {}): WorkFailureInput {
  return {
    stepKind: "work",
    agentKind: "structured",
    sessionError: true,
    hasReportOutput: false,
    failure: "spawn-missing",
    usedCandidate: 0,
    candidateCount: 2,
    nextCandidateBlocked: false,
    ...overrides,
  };
}

test("ENOENT 类文案分类为 spawn-missing 且允许降级", () => {
  assert.equal(classifyCandidateFailure("spawn claude ENOENT"), "spawn-missing");
  assert.equal(
    classifyCandidateFailure("codex exec 启动失败：spawn codex ENOENT（PATH 中找不到 codex 可执行文件；请确认 codex 已安装）"),
    "spawn-missing",
  );
  assert.equal(classifyCandidateFailure("未找到 claude CLI。"), "spawn-missing");
  assert.equal(classifyCandidateFailure("Claude Code native binary not found"), "spawn-missing");
  assert.equal(isDegradableWorkFailure(degradableInput()), true);
});

test("未启用会话分类为 host-disabled，异步判定核不放行", () => {
  assert.equal(classifyCandidateFailure("当前服务未启用结构化会话，无法派发 Agent。"), "host-disabled");
  assert.equal(classifyCandidateFailure("当前服务未启用终端会话，无法派发 Agent。"), "host-disabled");
  // 异步降级集合只含 spawn-missing / startup-timeout；host-disabled 的处置在同步派发路径（T3）。
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: "host-disabled" })), false);
});

test("无法归类的启动期错误一律 runtime-failure 不降级", () => {
  assert.equal(classifyCandidateFailure(""), "runtime-failure");
  assert.equal(classifyCandidateFailure(null), "runtime-failure");
  assert.equal(classifyCandidateFailure("socket hang up"), "runtime-failure");
  assert.equal(classifyCandidateFailure("模型不存在: some-model"), "runtime-failure", "事后不判 model-unknown");
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: "runtime-failure" })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: "model-unknown" })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: "format-error" })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: "user-stop" })), false);
});

test("startup window：窗口内 gone 且无输出判 startup-timeout，可降级", () => {
  assert.equal(AI_TEAM_STARTUP_WINDOW_MS, 45_000);
  const kind = classifyStartupFailure({ status: "failed", hasAssistantReply: false, elapsedMs: 10_000, errorMessage: null });
  assert.equal(kind, "startup-timeout");
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: kind })), true);
});

test("startup window：窗口外 failed 或有 assistant 回复一律 runtime-failure 不降级", () => {
  const outsideWindow = classifyStartupFailure({ status: "failed", hasAssistantReply: false, elapsedMs: AI_TEAM_STARTUP_WINDOW_MS });
  assert.equal(outsideWindow, "runtime-failure", "elapsed 恰等于窗口即视为窗口外");
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: outsideWindow })), false);

  const withOutput = classifyStartupFailure({ status: "failed", hasAssistantReply: true, elapsedMs: 1_000, errorMessage: "boom" });
  assert.equal(withOutput, "runtime-failure", "有输出后失败是业务/运行时失败，绝不降级");
  assert.equal(isDegradableWorkFailure(degradableInput({ failure: withOutput })), false);

  const alive = classifyStartupFailure({ status: "running", hasAssistantReply: false, elapsedMs: 1_000 });
  assert.equal(alive, "runtime-failure", "会话还活着不满足 isSessionGone 语义");
});

test("文案优先于窗口：ENOENT 错误即使会话已输出过也归 spawn-missing", () => {
  assert.equal(
    classifyStartupFailure({ status: "failed", hasAssistantReply: true, elapsedMs: 1_000, errorMessage: "spawn claude ENOENT" }),
    "spawn-missing",
  );
  assert.equal(isSessionGoneStatus("stopped"), true);
  assert.equal(isSessionGoneStatus("failed"), true);
  assert.equal(isSessionGoneStatus("exited"), true);
  assert.equal(isSessionGoneStatus("running"), false);
});

test("PTY 候选一律不降级（含 spawn-missing）", () => {
  assert.equal(isDegradableWorkFailure(degradableInput({ agentKind: "pty" })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ agentKind: "pty", failure: "startup-timeout" })), false);
});

test("降级判定核的其余闸：leader 步 / 无 sessionError / 已有报告 / 候选耗尽 / 下一候选被拉黑", () => {
  assert.equal(isDegradableWorkFailure(degradableInput({ stepKind: "leader" })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ sessionError: false })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ hasReportOutput: true })), false);
  // 首选失败、共 2 候选 → 可降级；已是最后一个候选 → 不可。
  assert.equal(isDegradableWorkFailure(degradableInput({ usedCandidate: 1, candidateCount: 2 })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ candidateCount: 1 })), false);
  assert.equal(isDegradableWorkFailure(degradableInput({ nextCandidateBlocked: true })), false);
});

test("model-unknown 只在事前且「拿不准就放行」", () => {
  const ready = ["claude-sonnet-x", "claude-opus-y"];
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost-model" }, ready), true);
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "claude-sonnet-x" }, ready), false, "精确命中清单放行");

  // "default" 永远放行（服务端解析默认模型）。
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "default" }, ready), false);
  // 冷启动 / 快照缺失 / 空清单 / 全脏条目 → 放行。
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost-model" }, []), false);
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost-model" }, null), false);
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost-model" }, undefined), false);
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost-model" }, [null, undefined]), false);

  // ModelCatalogService 的真实条目形状（ClaudeModelInfo[] 带 id）。
  assert.equal(isModelUnknownBeforeDispatch(structuredAgent, [{ id: "some-model", label: "X" }]), false);
  assert.equal(isModelUnknownBeforeDispatch({ ...structuredAgent, model: "ghost" }, [{ id: "some-model", label: "X" }]), true);
});
