import assert from "node:assert/strict";
import test from "node:test";
import { isDecisionToolCall, decisionCardSummary } from "../src/decision-tool.js";
import { enrichStructuredMessages } from "../src/structured-client-protocol.js";
import { collapsedBlockFlags, compactToolMessagesForTransport, truncateMessagesForTransport, visibleBlockCount, contentTransportBytes, windowMessagesForTransport } from "../src/message-truncator.js";
import { isToolActivityOnly, toolActivityTimeline, groupToolActivities } from "../src/web-ui/browser/tool-activity.js";
import type { ConversationTurn, ToolUseBlock, ToolResultBlock } from "../src/types.js";

const command = "node '/home/user/.agents/skills/wand-decision/scripts/decide.mjs' --stdin <<'JSON'\n{\"state\":\"refund\"}\nJSON";
const use = (): ToolUseBlock => ({ type: "tool_use", id: "decision-1", name: "Bash", input: { command } });
const result = (): ToolResultBlock => ({ type: "tool_result", tool_use_id: "decision-1", content: JSON.stringify({ runtime: "laya-mlx", experimental: true, answers: { department: { choice: "billing", evidence: "真实结果".repeat(100) } } }) });

test("decision presentation recognizes invocation forms, not status, documentation, or heredoc data", () => {
  const positive: Array<string | string[]> = [command, "wand decide --stdin", "printf '{}' | wand decide --stdin",
    'node "/project name/wand-decision/scripts/decide.mjs" --stdin',
    "node /opt/lib/node_modules/@co0ontty/wand/dist/cli.js decide --stdin",
    "node --import tsx /work/wand/src/cli.ts decide --stdin",
    '"$WAND_DECISION_NODE" "${WAND_DECISION_CLI}" decide --stdin',
    'env LANG=zh_CN.UTF-8 wand decide --stdin',
    ['bash', '-lc', 'wand decide --stdin'],
    'curl -X POST "$WAND_DECISION_URL/api/decisions/evaluate" --data @input.json',
  ];
  for (const input of positive) assert.equal(isDecisionToolCall({ type: "tool_use", name: "Bash", input: { command: input } }), true, String(input));
  for (const input of ["wand decide --status", command.replace("--stdin", "--status"),
    "echo 'wand decide --stdin'", "rg 'wand decide --stdin' README.md",
    "cat <<'JSON'\nwand decide --stdin\nJSON", "# wand decide --stdin\npwd",
    "node /unrelated/decide.mjs --stdin", "wand decision:configure --stdin",
    "curl http://localhost/api/decisions/status", "node -e \"console.log('wand decide --stdin')\"",
  ]) assert.equal(isDecisionToolCall({ name: "Bash", input: { command: input } }), false, input);
  assert.equal(isDecisionToolCall({ name: "Read", input: { command } }), false);
  assert.equal(isDecisionToolCall({ name: "exec_command", input: { cmd: command } }), true);
  assert.equal(isDecisionToolCall({ name: "Bash", input: {}, semantic: { kind: "decision" } }), true);
});

test("server projection marks decisions and late results without changing raw names, inputs, or stored history", () => {
  const messages: ConversationTurn[] = [{ role: "assistant", content: [use()] }, { role: "assistant", content: [result()] }];
  const before = JSON.stringify(messages);
  const enriched = enrichStructuredMessages(messages);
  // 请求体不是决策契约形状、结果缺 type 时，只给通用兜底文案，不编造题数或结论。
  const fallback = { kind: "decision", summary: { label: "选择 / 评分 / 是非判断" } };
  assert.deepEqual(enriched.map(turn => turn.content[0].type === "tool_use" || turn.content[0].type === "tool_result" ? turn.content[0].semantic : null), [fallback, fallback]);
  assert.equal((enriched[0].content[0] as ToolUseBlock).name, "Bash");
  assert.deepEqual((enriched[0].content[0] as ToolUseBlock).input, { command });
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(enrichStructuredMessages(enriched), enriched);
});

test("decision card summary projects the request body and the answer for both blocks", () => {
  const request = {
    state: "用户反映订单被重复扣款，希望退回多付的费用；网站其他功能正常。",
    questions: {
      category: { type: "choice", instructions: "这条请求最适合哪种处理类别？", criteria: { billing: "账单、扣款和退款" } },
      urgency: { type: "score", instructions: "按实际影响评估处理紧急程度。", criteria: ["常规处理", "需要尽快处理", "服务中断，立即处理"] },
      refund_requested: { type: "noul", instructions: "用户是否明确要求退款？" },
    },
  };
  const demoCommand = `node /home/user/.agents/skills/wand-decision/scripts/decide.mjs --stdin <<'JSON'\n${JSON.stringify(request)}\nJSON`;
  const demoResult = JSON.stringify({
    model: "aac6fef/laya-multilingual-mlx",
    answers: {
      category: { type: "choice", choice: "billing", probabilities: { billing: 0.8399, technical: 0.1567, other: 0.0034 } },
      urgency: { type: "score", score: 1.6674, legend: { 0: "常规处理", 1: "需要尽快处理", 2: "服务中断，立即处理" }, probabilities: { 1: 0.2761, 2: 0.6957 } },
      refund_requested: { type: "noul", noul: 0.9603 },
    },
    usage: { input_tokens: 179, output_tokens: 0, truncated: false },
    experimental: true,
    runtime: "laya-mlx",
  });
  const projected = enrichStructuredMessages([{ role: "assistant", content: [
    { type: "tool_use", id: "d1", name: "Bash", input: { command: demoCommand } },
    { type: "tool_result", tool_use_id: "d1", content: demoResult },
  ] }]);
  const use = projected[0]!.content[0] as ToolUseBlock;
  const toolResult = projected[0]!.content[1] as ToolResultBlock;
  // 两个块拿到同一份摘要：客户端不关心卡片是由入参还是迟到结果渲染的。
  assert.deepEqual(use.semantic, toolResult.semantic);
  assert.deepEqual(use.semantic, { kind: "decision", summary: {
    mode: "mixed",
    questions: 3,
    preview: request.state,
    outcome: "category=billing 84% · urgency=1.67/2（服务中断，立即处理） · refund_requested=P(true) 96%",
    label: "category=billing 84% · urgency=1.67/2（服务中断，立即处理） · refund_requested=P(true) 96% · 3 题 · 用户反映订单被重复扣款，希望退回多付的费用；网站其他功能正常。",
  } });
  // 结果未返回/失败时不编造结论，但请求侧要点仍然可用。
  const pending = enrichStructuredMessages([{ role: "assistant", content: [
    { type: "tool_use", id: "d2", name: "Bash", input: { command: demoCommand } },
    { type: "tool_result", tool_use_id: "d2", content: "boom", is_error: true },
  ] }]);
  const failed = (pending[0]!.content[0] as ToolUseBlock).semantic?.summary;
  assert.equal(failed?.outcome, undefined);
  assert.equal(failed?.mode, "mixed");
  assert.equal(failed?.questions, 3);
  assert.equal(failed?.label, `3 题 · ${request.state}`);
  // 请求体在文件里（`--data @input.json`）时读不出要点，只报结果侧，不留半截字段。
  const fileBody = enrichStructuredMessages([{ role: "assistant", content: [
    { type: "tool_use", id: "d3", name: "Bash", input: { command: 'curl -X POST "$WAND_DECISION_URL/api/decisions/evaluate" --data @input.json' } },
    { type: "tool_result", tool_use_id: "d3", content: '{"answers":{"q":{"type":"noul","noul":0.72}}}' },
  ] }]);
  assert.deepEqual((fileBody[0]!.content[0] as ToolUseBlock).semantic, {
    kind: "decision", summary: { mode: "noul", questions: 1, outcome: "q=P(true) 72%", label: "q=P(true) 72% · 1 题" },
  });
});

test("decision card summary stays bounded and deterministic on hostile input", () => {
  const command = `wand decide --stdin <<'JSON'\n${JSON.stringify({
    state: "x".repeat(4000),
    questions: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`q${i}`, { type: "choice", instructions: "i", criteria: { a: "A" } }])),
  })}\nJSON`;
  const longId = "i".repeat(200);
  const result = `{"answers":{${Array.from({ length: 8 }, (_, i) => `"q${i}":{"type":"choice","choice":"${longId}","probabilities":{"${longId}":0.9}}`).join(",")}}}`;
  const summary = decisionCardSummary({ command }, { content: result })!;
  assert.equal(summary.questions, 8);
  assert.ok(summary.preview!.length <= 64, String(summary.preview!.length));
  assert.ok(summary.outcome!.length <= 160, String(summary.outcome!.length));
  assert.ok(summary.label.length <= 180, String(summary.label.length));
  assert.equal(summary.label.includes(longId), false);
  assert.deepEqual(decisionCardSummary({ command }, { content: result }), summary);
  // 非决策输出、损坏 JSON、缺 answers 都不产生摘要。
  for (const content of ["plain text", "{", '{"answers":[]}', '{"answers":{}}', ""])
    assert.equal(decisionCardSummary({ command }, { content })?.outcome, undefined, content);
});

test("compact, legacy, result-only windows and defaults preserve decision bodies", () => {
  const messages: ConversationTurn[] = [{ role: "assistant", content: [use(), result()] }];
  const enriched = enrichStructuredMessages(messages);
  const compact = compactToolMessagesForTransport(enriched);
  assert.deepEqual(compact[0].content, enriched[0].content);
  assert.deepEqual(truncateMessagesForTransport(compact, { terminal: false }), compact);
  assert.deepEqual(collapsedBlockFlags(compact[0].content, { terminal: false }), [false, false]);
  assert.equal(visibleBlockCount(compact[0].content, {}, 2), 2);
  assert.ok(contentTransportBytes(compact[0].content, {}) > (result().content as string).length);
  const crossTurn = enrichStructuredMessages([{ role: "assistant", content: [use()] }, { role: "assistant", content: [result()] }]);
  const window = windowMessagesForTransport(crossTurn, { terminal: false }, 1);
  assert.equal((window.messages[0].content[0] as ToolResultBlock).content, result().content);
  assert.deepEqual(collapsedBlockFlags(window.messages[0].content, {}), [false]);
  const rawCompact = compactToolMessagesForTransport(messages);
  assert.equal((rawCompact[0].content[0] as ToolUseBlock).semantic?.kind, "decision");
  // 压缩不会把服务端摘要降回只剩 kind。
  const richUse: ToolUseBlock = { ...use(), semantic: { kind: "decision", summary: { label: "3 题" } }, activity: { kind: "run_command", label: "运行命令" } };
  const richCompact = compactToolMessagesForTransport([{ role: "assistant", content: [richUse] }]);
  assert.deepEqual((richCompact[0].content[0] as ToolUseBlock).semantic, { kind: "decision", summary: { label: "3 题" } });
  assert.equal((richCompact[0].content[0] as ToolUseBlock).activity, undefined);
  assert.equal((rawCompact[0].content[1] as ToolResultBlock).content, result().content);
  const normal: ToolUseBlock = { ...use(), id: "status", input: { command: "wand decide --status" } };
  const folded = compactToolMessagesForTransport([{ role: "assistant", content: [normal] }]);
  assert.ok((folded[0].content[0] as ToolUseBlock).activity);
});

test("decision calls stay outside activity-only wrappers and timeline groups even with stale activity metadata", () => {
  const block: ToolUseBlock = { ...use(), semantic: { kind: "decision" }, activity: { kind: "run_command", label: "运行命令" } };
  assert.equal(isToolActivityOnly([block]), false);
  assert.deepEqual(toolActivityTimeline([{ block, index: 0 }]), []);
  assert.equal(groupToolActivities([{ block, index: 0 }]).run_command.length, 0);
  assert.equal(isToolActivityOnly([{ ...block, input: {}, semantic: undefined }], new Set([block.id])), false);
  for (const output of [{ ...result(), is_error: true }, undefined]) {
    const enriched = enrichStructuredMessages([{ role: "assistant", content: [use(), ...(output ? [output] : [])] }]);
    assert.equal((enriched[0].content[0] as ToolUseBlock).semantic?.kind, "decision");
  }
});
