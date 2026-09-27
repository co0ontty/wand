import assert from "node:assert/strict";
import test from "node:test";

import {
  alignedBlockStart,
  blockWindowMessagesForTransport,
  contentTransportBytes,
  visibleBlockCount,
} from "../src/message-truncator.js";
import type { ContentBlock, ConversationTurn } from "../src/types.js";

function text(value: string): ContentBlock {
  return { type: "text", text: value };
}

function thinking(value: string): ContentBlock {
  return { type: "thinking", thinking: value };
}

function toolUse(id: string, name = "Bash"): ContentBlock {
  return { type: "tool_use", id, name, input: {} };
}

function toolResult(id: string): ContentBlock {
  return { type: "tool_result", tool_use_id: id, content: "ok", is_error: false };
}

function assistantTurn(content: ContentBlock[]): ConversationTurn {
  return { role: "assistant", content };
}

function userTurn(value: string): ConversationTurn {
  return { role: "user", content: [text(value)] };
}

/** 折叠段（thinking + 默认收起的工具调用）连续 N 组；pad 用来把折叠内容做大。 */
function collapsedRun(count: number, pad = 0): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `tool-${index}`;
    blocks.push(thinking(`思考 ${index}${"x".repeat(pad)}`), toolUse(id), toolResult(id));
  }
  return blocks;
}

/** 窗口里不允许出现「无头」tool_result —— 客户端会把它渲染成剥掉工具名的结果卡。 */
function orphanResults(content: ContentBlock[]): number {
  const useIds = new Set(content.filter((block) => block.type === "tool_use").map((block) => block.id));
  return content.filter((block) => block.type === "tool_result" && !useIds.has(block.tool_use_id)).length;
}

test("一条提示词 + 一段长工具回复不窗口化：不出现「更早消息」", () => {
  // 600 个默认收起的块（客户端合并成折叠条）+ 两轮用户消息，可见条数远小于预算。
  const turns = [
    userTurn("把安卓上拉加载更早消息的逻辑修一下"),
    assistantTurn([text("先看代码。"), ...collapsedRun(200), text("改完了。")]),
    userTurn("还是不行"),
    assistantTurn([thinking("看日志"), toolUse("t1")]),
  ];

  const windowed = blockWindowMessagesForTransport(turns, {}, 60);

  assert.equal(windowed.messageOffset, 0, "整段历史应当一次下发");
  assert.equal(windowed.leadingBlockOffset, 0);
  assert.equal(windowed.leadingVisibleCount, 0);
  assert.equal(windowed.messages.length, turns.length);
  assert.equal(windowed.messages[1].content.length, turns[1].content.length);
});

test("可见条数超预算才窗口化，折叠的工具块不占预算", () => {
  // 三段正文 + 两大段折叠工具调用；可见预算只放得下后两段。
  const content = [text("第一段"), ...collapsedRun(50), text("第二段"), ...collapsedRun(50), text("第三段")];
  const windowed = blockWindowMessagesForTransport([assistantTurn(content)], {}, 2);

  assert.equal(windowed.messageOffset, 0);
  assert.ok(windowed.leadingBlockOffset > 0, "应当切掉头部");
  assert.equal(windowed.leadingVisibleCount, 1, "头部只剩第一段正文");
  // 窗口里留住了两段正文（折叠块免费），不是「按块数」切出来的十几块。
  assert.equal(visibleBlockCount(content, {}, windowed.leadingBlockOffset), 1);
  assert.equal(
    visibleBlockCount(windowed.messages[0].content, {}, windowed.messages[0].content.length),
    2,
  );
  assert.equal(orphanResults(windowed.messages[0].content), 0);
});

test("载荷上限逼出的切点会回到配对的 tool_use，不留无头结果", () => {
  const content = [
    text("x".repeat(300)),
    thinking("y".repeat(300)),
    toolUse("t"),
    toolResult("t"),
    text("z".repeat(100)),
  ];
  const byteBudget = contentTransportBytes([toolResult("t"), text("z".repeat(100))], {});
  const windowed = blockWindowMessagesForTransport([assistantTurn(content)], {}, 60, byteBudget);

  // 切点先回到配对的 tool_use，再回到整段折叠内容的首（不留给客户端半截工具段）。
  assert.equal(content[windowed.leadingBlockOffset]?.type, "thinking");
  assert.equal(windowed.leadingVisibleCount, 1);
  assert.equal(orphanResults(windowed.messages[0].content), 0);
});

test("切点落在配对的 tool_result 上时带回它的 tool_use", () => {
  const content = [toolUse("a"), toolResult("a"), text("正文")];
  assert.equal(alignedBlockStart(content, {}, 1), 0);
  assert.equal(alignedBlockStart(content, {}, 2), 2);
});

test("超长折叠段不为了吸附把首屏撑大：超过上限改为跳到段后", () => {
  const run = collapsedRun(200, 1_000); // 600 块、约 200KB
  const content = [text("正文"), ...run, text("结尾")];
  const start = alignedBlockStart(content, {}, 400);
  assert.ok(start > 400, `expected forward skip, got ${start}`);
  assert.equal(content[start]?.type, "text");

  // 翻页路径不允许越过本页末尾（否则客户端游标会前移、翻页原地打转）。
  assert.equal(alignedBlockStart(content, {}, 400, 500), 400);
});

test("载荷超上限时按体积切，且至少保留一块内容", () => {
  const content = [text("x".repeat(500)), text("y".repeat(500)), text("z".repeat(500))];
  const windowed = blockWindowMessagesForTransport([assistantTurn(content)], {}, 60, 700);

  assert.ok(windowed.leadingBlockOffset > 0, "应当切掉头部");
  assert.ok(windowed.messages[0].content.length >= 1);
  assert.ok(contentTransportBytes(windowed.messages[0].content, {}) <= 700 + 8);
});

test("可见条数只数非折叠块，工具调用成段不占额度", () => {
  const content = [text("正文"), ...collapsedRun(50), text("结尾")];
  assert.equal(visibleBlockCount(content, {}, content.length), 2);
  assert.equal(visibleBlockCount(content, {}, 1), 1);
  // 打开工具卡片偏好后工具块本身也算可见内容。
  assert.equal(visibleBlockCount(content, { terminal: true, thinking: true }, content.length), 152);
});
