import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRunBlockKey,
  agentRunTouchesMessage,
  buildAgentRunRenderSignature,
  collectAgentRuns,
  deriveSubagentMeta,
  getAgentRunStatusSummary,
  shouldAgentRunStartExpanded,
} from "../src/web-ui/browser/agent-runs.js";

function subagent(taskId: string, agentType: string): Record<string, unknown> {
  return { taskId, agentType, taskDescription: `检查 ${taskId}` };
}

function dispatch(taskId: string, agentType: string): Record<string, unknown> {
  return {
    type: "tool_use",
    name: "Agent",
    id: taskId,
    input: { subagent_type: agentType, description: `检查 ${taskId}` },
    __subagent: subagent(taskId, agentType),
  };
}

function child(taskId: string, agentType: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, __subagent: subagent(taskId, agentType), ...extra };
}

test("连续 dispatch 合并成一个 Agent Run，并保留各自轨迹", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "并行检查" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "分给两只 Agent。" },
        dispatch("agent-a", "general-purpose"),
        child("agent-a", "general-purpose", "thinking", { thinking: "检查 A" }),
        dispatch("agent-b", "Explore"),
        child("agent-b", "Explore", "text", { text: "检查 B" }),
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  assert.equal(index.runs.length, 1);
  assert.deepEqual(index.runs[0].agents.map((agent) => agent.taskId), ["agent-a", "agent-b"]);
  assert.equal(index.runs[0].startBlockIndex, 1);
  assert.equal(index.runs[0].endBlockIndex, 4);
  assert.equal(index.agentByTaskId.get("agent-a")?.blocks.length, 1);
  assert.equal(index.agentByTaskId.get("agent-b")?.blocks.length, 1);
  assert.equal(index.ownerByBlockKey.get(agentRunBlockKey(1, 1)), "agent-a");
  assert.equal(index.ownerByBlockKey.get(agentRunBlockKey(1, 4)), "agent-b");
});

test("父正文切断 Run，后续 dispatch 另起一个 Run", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        dispatch("agent-a", "general-purpose"),
        child("agent-a", "general-purpose", "text", { text: "A 的进展" }),
        { type: "text", text: "A 完成后继续 B。" },
        dispatch("agent-b", "Explore"),
        child("agent-b", "Explore", "text", { text: "B 的进展" }),
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  assert.equal(index.runs.length, 2);
  assert.deepEqual(index.runs.map((run) => run.agents.map((agent) => agent.taskId)), [["agent-a"], ["agent-b"]]);
  assert.deepEqual(index.runs.map((run) => run.startBlockIndex), [0, 3]);
});

test("结果跨消息到达时仍归属原 Run，且不混入过程 blocks", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        dispatch("agent-a", "general-purpose"),
        child("agent-a", "general-purpose", "text", { text: "执行中" }),
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "agent-a",
          is_error: false,
          content: [{ type: "text", text: "最终结论" }],
          __subagent: subagent("agent-a", "general-purpose"),
        },
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  const agent = index.agentByTaskId.get("agent-a");
  assert.equal(index.runs.length, 1);
  assert.equal(index.runs[0].messageIndex, 0);
  assert.equal(agent?.result?.messageIndex, 1);
  assert.equal(agent?.blocks.length, 1);
  assert.equal(index.ownerByBlockKey.get(agentRunBlockKey(1, 0)), "agent-a");
});

test("无 __subagent 的历史 Task / Agent 会从 tool_use 降级识别", () => {
  const task = {
    type: "tool_use",
    name: "Task",
    id: "legacy-task",
    input: { subagent_type: "code-reviewer", description: "检查错误路径" },
  };
  const result = {
    type: "tool_result",
    tool_use_id: "legacy-task",
    is_error: true,
    content: [{ type: "text", text: "失败" }],
  };
  const messages = [{ role: "assistant", content: [task] }, { role: "user", content: [result] }];

  assert.deepEqual(deriveSubagentMeta(task), {
    taskId: "legacy-task",
    agentType: "code-reviewer",
    taskDescription: "检查错误路径",
  });
  const index = collectAgentRuns(messages);
  assert.equal(index.runs.length, 1);
  assert.equal(index.agentByTaskId.get("legacy-task")?.result?.block, result);
  assert.equal(index.ownerByBlockKey.get(agentRunBlockKey(1, 0)), "legacy-task");
});

test("空的 processing / thinking / tool_result 不会切断连续 Agent Run", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        dispatch("agent-a", "general-purpose"),
        { type: "text", text: "", __processing: true },
        child("agent-a", "general-purpose", "thinking", { thinking: "" }),
        child("agent-a", "general-purpose", "tool_result", { tool_use_id: "child-tool", content: [] }),
        dispatch("agent-b", "Explore"),
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  assert.equal(index.runs.length, 1);
  assert.deepEqual(index.runs[0].agents.map((agent) => agent.taskId), ["agent-a", "agent-b"]);
});

test("重复 taskId 只建立一个 Agent 和一个 Run", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        dispatch("agent-a", "general-purpose"),
        child("agent-a", "general-purpose", "text", { text: "第一段" }),
        { type: "text", text: "中间正文" },
        dispatch("agent-a", "general-purpose"),
        child("agent-a", "general-purpose", "text", { text: "第二段" }),
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  assert.equal(index.runs.length, 1);
  assert.equal(index.runs[0].startBlockIndex, 0);
  assert.equal(index.runs[0].agents.length, 1);
  assert.equal(index.agentByTaskId.get("agent-a")?.dispatch?.blockIndex, 0);
});

test("Run 状态按 failed > running > interrupted > completed 聚合", () => {
  const complete = child("complete", "general-purpose", "tool_result", {
    tool_use_id: "complete",
    is_error: false,
    content: [{ type: "text", text: "完成" }],
  });
  const failed = child("failed", "Explore", "tool_result", {
    tool_use_id: "failed",
    is_error: true,
    content: [{ type: "text", text: "失败" }],
  });
  const running = child("running", "general-purpose", "text", { text: "运行中" });
  const messages = [
    {
      role: "assistant",
      content: [
        dispatch("complete", "general-purpose"),
        complete,
        dispatch("failed", "Explore"),
        failed,
        dispatch("running", "general-purpose"),
        running,
      ],
    },
  ];

  const index = collectAgentRuns(messages);
  const summary = getAgentRunStatusSummary(index.runs[0], true);
  assert.equal(summary.status, "failed");
  assert.deepEqual(
    { total: summary.total, failed: summary.failed, running: summary.running, completed: summary.completed },
    { total: 3, failed: 1, running: 1, completed: 1 },
  );

  const interrupted = getAgentRunStatusSummary(index.runs[0], false);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.interrupted, 1);
  assert.equal(interrupted.running, 0);
});

test("live 只归属于当前消息中仍在执行的 Run", () => {
  const messages = [
    { role: "assistant", content: [dispatch("old", "general-purpose"), child("old", "general-purpose", "text", { text: "旧" })] },
    { role: "assistant", content: [dispatch("new", "Explore"), child("new", "Explore", "text", { text: "新" })] },
  ];
  const index = collectAgentRuns(messages);
  assert.equal(agentRunTouchesMessage(index.runs[0], 0), true);
  assert.equal(agentRunTouchesMessage(index.runs[0], 1), false);
  assert.equal(agentRunTouchesMessage(index.runs[1], 1), true);
});

test("渲染签名会随子 Agent 结果变化，避免增量渲染漏刷新锚点", () => {
  const base = {
    role: "assistant",
    content: [dispatch("agent-a", "general-purpose"), child("agent-a", "general-purpose", "text", { text: "进行中" })],
  };
  const before = buildAgentRunRenderSignature(collectAgentRuns([base]));
  const withResult = {
    role: "assistant",
    content: base.content.concat([child("agent-a", "general-purpose", "tool_result", {
      tool_use_id: "agent-a",
      is_error: false,
      content: [{ type: "text", text: "完成" }],
    })]),
  };
  const after = buildAgentRunRenderSignature(collectAgentRuns([withResult]));
  assert.notEqual(before, after);
});

test("默认展开规则：运行/失败展开，完成/中断收起，用户选择优先", () => {
  assert.equal(shouldAgentRunStartExpanded("running", null), true);
  assert.equal(shouldAgentRunStartExpanded("failed", null), true);
  assert.equal(shouldAgentRunStartExpanded("completed", null), false);
  assert.equal(shouldAgentRunStartExpanded("interrupted", null), false);
  assert.equal(shouldAgentRunStartExpanded("running", false), false);
  assert.equal(shouldAgentRunStartExpanded("completed", true), true);
});
