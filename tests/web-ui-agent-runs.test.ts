import assert from "node:assert/strict";
import test from "node:test";

import {
  agentRunAccentSeed,
  agentRunAgentTitle,
  agentRunBlockKey,
  agentRunInLatestWindow,
  agentRunResultRawText,
  agentRunStatusLabelKey,
  buildAgentRunRenderSignature,
  collectAgentRuns,
  deriveSubagentMeta,
  flattenAgentRunInline,
  getAgentRunStatusSummary,
  parseAsyncDispatchReceipt,
  shouldAgentRunStartExpanded,
  truncateInlineText,
} from "../src/web-ui/browser/agent-runs.js";

const LIVE = { sessionRunning: true, inLatestWindow: true };
const SETTLED = { sessionRunning: false, inLatestWindow: true };
const OUT_OF_WINDOW = { sessionRunning: false, inLatestWindow: false };

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

test("Run 状态按 failed > running > background > interrupted > pending > completed 聚合", () => {
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
  const summary = getAgentRunStatusSummary(index.runs[0], LIVE);
  assert.equal(summary.status, "failed");
  assert.deepEqual(
    { total: summary.total, failed: summary.failed, running: summary.running, completed: summary.completed },
    { total: 3, failed: 1, running: 1, completed: 1 },
  );

  // 会话已停：本轮里没结果的那个才是「已中断」。
  const interrupted = getAgentRunStatusSummary(index.runs[0], SETTLED);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.interrupted, 1);
  assert.equal(interrupted.running, 0);

  // 不在最新一轮（分页窗口截断的历史 run）：没结果只说「未完成」，不能谎报「已中断」。
  const pending = getAgentRunStatusSummary(index.runs[0], OUT_OF_WINDOW);
  assert.equal(pending.status, "failed");
  assert.equal(pending.interrupted, 0);
  assert.equal(pending.pending, 1);
});

test("状态口径：running / interrupted / pending 由会话与窗口两个事实决定", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "查一下" }] },
    { role: "assistant", content: [dispatch("a", "Explore"), child("a", "Explore", "text", { text: "进展" })] },
  ];
  const run = collectAgentRuns(messages).runs[0];
  assert.equal(getAgentRunStatusSummary(run, LIVE).status, "running");
  assert.equal(getAgentRunStatusSummary(run, SETTLED).status, "interrupted");
  assert.equal(getAgentRunStatusSummary(run, OUT_OF_WINDOW).status, "pending");
  assert.equal(agentRunStatusLabelKey("pending", LIVE), "agentRun.status.pending");
  assert.equal(agentRunStatusLabelKey("completed", LIVE), "agentRun.status.completed");
});

test("最新窗口按最后一条真人文本轮判定，子 Agent 轨迹与结果不算文本轮", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "并行检查" }] },
    { role: "assistant", content: [dispatch("old", "general-purpose"), child("old", "general-purpose", "text", { text: "旧" })] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: [{ type: "text", text: "旧结论" }] }] },
    { role: "user", content: [{ type: "text", text: "再来一轮" }] },
    // 真人外观（role=user + 非空 text），但带 __subagent 戳：这是子 Agent 回传的轨迹，
    // 不是用户又发了一轮。排掉它这条判据才成立——否则窗口会被一路推到最新 run 之后，
    // 正在跑的 Agent 反被读成「未完成」。
    { role: "user", content: [{ type: "text", text: "子 Agent 回传进展", __subagent: subagent("extra", "general-purpose") }] },
    { role: "assistant", content: [dispatch("new", "Explore"), child("new", "Explore", "text", { text: "新" })] },
  ];
  const index = collectAgentRuns(messages);
  // 下标 2 与 4 都是子 Agent 回传的 user 消息，都不能把窗口推到后面（真人轮只有 0 和 3）。
  assert.equal(index.lastUserTextMessageIndex, 3);
  const byTask = (taskId: string) => index.runs.find((run) => run.agents[0].taskId === taskId);
  assert.equal(agentRunInLatestWindow(byTask("new")!, index.lastUserTextMessageIndex), true);
  assert.equal(agentRunInLatestWindow(byTask("old")!, index.lastUserTextMessageIndex), false);
  // 结果晚于文本轮到达的历史 run，仍算在最新窗口里（该显示运行态而不是「未完成」）。
  const late = collectAgentRuns([
    { role: "user", content: [{ type: "text", text: "开始" }] },
    { role: "assistant", content: [dispatch("late", "Explore")] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "late", content: [{ type: "text", text: "回来了" }] }] },
  ]);
  assert.equal(agentRunInLatestWindow(late.runs[0], late.lastUserTextMessageIndex), true);
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
  // 后台派发没有结论可看，默认展开把回执亮出来。
  assert.equal(shouldAgentRunStartExpanded("background", null), true);
});

test("标题取名：任务描述优先，无描述退类型，两者都无退兜底", () => {
  const withDescription = { taskId: "t1", meta: { taskId: "t1", agentType: "Explore", taskDescription: "审计渲染层" } };
  const typeOnly = { taskId: "t2", meta: { taskId: "t2", agentType: "Explore" } };
  const bare = { taskId: "t3", meta: { taskId: "t3" } };
  assert.equal(agentRunAgentTitle(withDescription as any, "子 Agent"), "审计渲染层");
  assert.equal(agentRunAgentTitle(typeOnly as any, "子 Agent"), "Explore");
  assert.equal(agentRunAgentTitle(bare as any, "子 Agent"), "子 Agent");
  assert.equal(agentRunAgentTitle(null, "子 Agent"), "子 Agent");
});

test("身份色按 taskId 派生，同类型并行不撞色", () => {
  const a = { taskId: "task-a", meta: { taskId: "task-a", agentType: "general-purpose" } };
  const b = { taskId: "task-b", meta: { taskId: "task-b", agentType: "general-purpose" } };
  assert.equal(agentRunAccentSeed(a), "task-a");
  assert.notEqual(agentRunAccentSeed(a), agentRunAccentSeed(b));
  // 无 taskId 时才回落类型名，避免空种子。
  assert.equal(agentRunAccentSeed({ taskId: "", meta: { taskId: "", agentType: "Explore" } } as any), "Explore");
});

/**
 * 以下三条 fixture 是**逐字取自真实日志**的样本，不是手搓形状
 * （来源与全量聚类见 `.wand-team/run_46c0a39145b3/8-m_ca82f853.md`：271 条
 * `Pi/subagent` toolResult）。上一轮那条 `Async: dispatched [uuid]` +
 * `Output: …/<uuid>.jsonl` 的组合在真实样本里一条都不存在，正是判据一直没被
 * 发现是死判据的原因，已删除。
 */
const PI_SINGLE_RECEIPT = "Run fan-out: 1/64 used, 63 remaining\n" +
  "Async: wand-team-sol [72dddd42-dc49-4ba9-8dcb-45a0d07e3e01]\n\n" +
  "The async run is detached and running in the background.\n" +
  "You are in an interactive session. Return control to the user now; Pi will wake you " +
  "through the native completion notification when this subagent completes or needs attention.\n" +
  "Mission: 2d310602-4bab-4c9b-a3d8-19d78003a331 (active)";

const PI_WORKFLOW_RECEIPT = "Run fan-out: 0/64 used, 64 remaining\n" +
  "Async workflow [79c600cb-1714-43e9-ad65-756177c8bb34]\n\n" +
  "The async run is detached and running in the background.\n" +
  "Override the default and call blocking subagent_wait() before ending the turn only when " +
  "the current request is run-to-completion\n" +
  "Mission: 4d524beb-3217-4ce1-9a87-f6b35b011e59 (active)";

// 状态查询：正文里同时含 `Run fan-out:` 与 `Output:`，但它是查询、不是派发回执。
const PI_STATUS_TEXT = "Status target: run 02559929-4b9b-467e-b930-bc532138515c\n" +
  "State: running\nMode: single\nRun fan-out: 1/64 used, 63 remaining\n" +
  "Dir: /var/folders/tf/.../async-subagent-runs/02559929-4b9b-467e-b930-bc532138515c\n" +
  "Output: /var/folders/tf/.../async-subagent-runs/02559929-4b9b-467e-b930-bc532138515c/output-0.log\n" +
  "Events: /var/folders/tf/.../async-subagent-runs/02559929-4b9b-467e-b930-bc532138515c/events.jsonl";

// 转录查询：含 `Output:` 且真的带回子 Agent 报告正文，绝不能当回执吞掉。
const PI_TRANSCRIPT_TEXT = "Transcript target: run 881a7591-b9ab-4663-ac64-779cf8092b47\n" +
  "State: completed\nOutput: /Users/u/.pi/.../881a7591_reviewer_0_output.md\n" +
  "Result transcript tail:\n  ## Review\n  1. **中等：Grok 历史会话被错误归类**";

// 完成事件：真实报告，首行固定 Background task completed。
const PI_NOTIFY_TEXT = "Background task completed: **wand-team-sol**\n\n" +
  "wand-team-sol:\n# Sol review\n\n**Verdict: FAIL for this slice.**";

const QODER_ACK = "Async agent launched successfully.\n" +
  "agentId: ageneral-purpose-ca16580eee0d40fb (internal ID - do not mention to user.)\n" +
  "The agent is working in the background. You will be notified automatically when it completes.\n" +
  "Do not duplicate this agent's work — avoid working with the same files or topics it is using.\n" +
  "output_file: /var/folders/tf/.../tasks/ab9dd6834d59e0307.output\n" +
  "Do NOT read or tail this file via the shell tool — it is the full subagent JSONL transcript.";

function receiptAgent(taskId: string, resultText: string) {
  return collectAgentRuns([
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Pi/subagent", id: taskId, __subagent: subagent(taskId, "reviewer") },
        child(taskId, "reviewer", "tool_result", {
          tool_use_id: taskId,
          is_error: false,
          content: resultText,
        }),
      ],
    },
  ]);
}

test("真实派发回执按形状识别：pi 单发 / pi 工作流 / qoder ack", () => {
  // 真实 pi 回执没有 Output: 行，outputPath 为空是正常情况，不得因此否决。
  assert.deepEqual(parseAsyncDispatchReceipt(PI_SINGLE_RECEIPT), {
    runId: "72dddd42-dc49-4ba9-8dcb-45a0d07e3e01",
    outputPath: "",
  });
  assert.deepEqual(parseAsyncDispatchReceipt(PI_WORKFLOW_RECEIPT), {
    runId: "79c600cb-1714-43e9-ad65-756177c8bb34",
    outputPath: "",
  });
  // qoder 的 id 在 agentId: 行且不是 uuid，输出文件是小写 output_file:。
  assert.deepEqual(parseAsyncDispatchReceipt(QODER_ACK), {
    runId: "ageneral-purpose-ca16580eee0d40fb",
    outputPath: "/var/folders/tf/.../tasks/ab9dd6834d59e0307.output",
  });
  // 类型名自带方括号时取最后一个括号段，不能因为先撞上 `[general]` 就抽不到 id。
  assert.deepEqual(
    parseAsyncDispatchReceipt("Run fan-out: 1/64 used, 63 remaining\n" +
      "Async: worker[general] [4f9c1a2b-0000-1111-2222-333344445555]"),
    { runId: "4f9c1a2b-0000-1111-2222-333344445555", outputPath: "" },
  );
  // 真实语料里派发行最远落到第 15 行（中间是 10 lanes 的 Preflight 计划表）。
  // 窗口写死「第二行」或太窄都会让它掉进兜底层：状态还是 background，但 runId 丢成空串。
  const lanes: string[] = [];
  for (let i = 0; i < 12; i++) lanes.push(`  lane-${i} | mutation | 只改自己名下的文件`);
  assert.deepEqual(
    parseAsyncDispatchReceipt(["Run fan-out: 0/64 used, 64 remaining",
      "Preflight: v1 · complete · 12 lanes",
      "  key | mode | decision",
      ...lanes,
      "Async workflow [3a2b1c0d-9f8e-7d6c-5b4a-392817061504]",
      "",
      "The async run is detached and running in the background."].join("\n")),
    { runId: "3a2b1c0d-9f8e-7d6c-5b4a-392817061504", outputPath: "" },
  );
});

test("状态查询 / 转录报告 / 完成事件一律否决，不当回执吞掉正文", () => {
  // 这三条都含 `Output:`，说明「含 Output: 就算回执」的方向天然制造误判。
  assert.equal(parseAsyncDispatchReceipt(PI_STATUS_TEXT), null);
  assert.equal(parseAsyncDispatchReceipt(PI_TRANSCRIPT_TEXT), null);
  assert.equal(parseAsyncDispatchReceipt(PI_NOTIFY_TEXT), null);
  assert.equal(parseAsyncDispatchReceipt("## 结论\n复核通过。"), null);
  // 只有预算行、第二行不是派发形状 → 不硬判。
  assert.equal(parseAsyncDispatchReceipt("Run fan-out: 1/64 used, 63 remaining\nMission: x"), null);
  assert.equal(parseAsyncDispatchReceipt(""), null);
});

test("认不出形状但正文明确说已交后台 → 兜底判 background，绝不标绿结论", () => {
  const suspected = "Subagent handed off.\nIt is working in the background and you " +
    "will be notified automatically when it completes.";
  assert.deepEqual(parseAsyncDispatchReceipt(suspected), { runId: "", outputPath: "" });
  const index = receiptAgent("sus-1", suspected);
  const agent = index.agentByTaskId.get("sus-1");
  assert.ok(agent?.receipt);
  assert.equal(getAgentRunStatusSummary(index.runs[0], LIVE).status, "background");
  assert.equal(getAgentRunStatusSummary(index.runs[0], SETTLED).status, "background");
});

test("派发回执不当最终结论：三种真实形状都走 background", () => {
  for (const [taskId, text] of [
    ["pi-single", PI_SINGLE_RECEIPT],
    ["pi-workflow", PI_WORKFLOW_RECEIPT],
    ["qoder-ack", QODER_ACK],
  ] as Array<[string, string]>) {
    const index = receiptAgent(taskId, text);
    const agent = index.agentByTaskId.get(taskId);
    assert.deepEqual(agent?.receipt, parseAsyncDispatchReceipt(text), taskId);
    assert.equal(getAgentRunStatusSummary(index.runs[0], LIVE).status, "background", taskId);
    assert.equal(getAgentRunStatusSummary(index.runs[0], SETTLED).status, "background", taskId);
  }
  assert.equal(agentRunStatusLabelKey("background", LIVE), "agentRun.status.background");
  assert.equal(agentRunStatusLabelKey("background", SETTLED), "agentRun.status.backgroundDone");

  // 真报告仍然走 completed，且 receipt 为空——否决层不能把结果一起吞掉。
  const report = receiptAgent("pi-report", PI_TRANSCRIPT_TEXT);
  assert.equal(report.agentByTaskId.get("pi-report")?.receipt, null);
  assert.equal(getAgentRunStatusSummary(report.runs[0], SETTLED).status, "completed");
  // 失败的结果不判回执，保持「失败原因」。
  const failed = collectAgentRuns([
    {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Pi/subagent", id: "pi-err", __subagent: subagent("pi-err", "reviewer") },
        child("pi-err", "reviewer", "tool_result", {
          tool_use_id: "pi-err",
          is_error: true,
          content: "Async agent launched successfully.\nagentId: ax1\nIt is working in the background.",
        }),
      ],
    },
  ]);
  assert.equal(failed.agentByTaskId.get("pi-err")?.receipt, null);
  assert.equal(getAgentRunStatusSummary(failed.runs[0], LIVE).status, "failed");
});

test("结论体保留换行，摘要行才压平并去掉 markdown 记号", () => {
  const block = {
    type: "tool_result",
    tool_use_id: "t",
    content: [{ type: "text", text: "## 结论\n- 通过\n- 复审 `ready`\n\n```ts\nconst a = 1;\n```" }],
  };
  assert.equal(agentRunResultRawText(block), "## 结论\n- 通过\n- 复审 `ready`\n\n```ts\nconst a = 1;\n```");
  assert.equal(agentRunResultRawText({ type: "tool_result", content: "字符串结果\n第二行" }), "字符串结果\n第二行");
  // 多段 content 之间必须是 `\n`：provider 常把一份报告拆成多个 text 块回传，
  // 拼成空格会让 `## 标题` 与 `- 列表` 前缀全部失效（整篇塌成一段）。
  const multi = {
    type: "tool_result",
    tool_use_id: "t2",
    content: [{ type: "text", text: "## 结论" }, { type: "text", text: "- 通过" }],
  };
  assert.equal(agentRunResultRawText(multi), "## 结论\n- 通过");
  assert.ok(agentRunResultRawText(multi).includes("\n"), "多段结果之间必须保留换行");

  const inline = flattenAgentRunInline(agentRunResultRawText(block));
  assert.ok(!inline.includes("##"), inline);
  assert.ok(!inline.includes("`"), inline);
  assert.ok(!inline.includes("\n"), inline);
  assert.ok(inline.startsWith("结论 "), inline);
  assert.equal(truncateInlineText("一二三四五六七八九十", 6), "一二三四五…");
  assert.equal(truncateInlineText("短", 6), "短");
  // 摘要行是**纯文本一行**，所以行内 markdown 记号要剥掉（`__ready__` → `ready`）；
  // 记号只在结论体里由 renderMarkdown 解释，摘要行走 escapeHtml，留着就是噪音。
  assert.equal(flattenAgentRunInline("状态 __ready__ 已就绪"), "状态 ready 已就绪");
  assert.equal(flattenAgentRunInline("状态 *ready* 已就绪"), "状态 ready 已就绪");
  // 正文侧原样保留：同一段文本走 agentRunResultRawText 时记号一个不少。
  assert.equal(
    agentRunResultRawText({ type: "tool_result", content: [{ type: "text", text: "状态 __ready__ 已就绪" }] }),
    "状态 __ready__ 已就绪",
  );
});
