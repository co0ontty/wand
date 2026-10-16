import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationTurn, ConversationSessionPreview } from "../src/types.js";
import { ConversationSessionReply } from "../src/web-ui/react/conversations/session-preview.js";

function render(status: ConversationSessionPreview["status"], statusProvided = false): string {
  const turn: ConversationTurn = { role: "assistant", messageId: "reply", conversationId: "dm-test", content: [],
    sessionLink: { sessionId: "source-session", title: "本轮工作" }, sessionPreview: { status, text: "这是测试正文" } };
  return renderToStaticMarkup(React.createElement(ConversationSessionReply, {
    turn, active: false, statusProvided, onOpen() {},
    children: statusProvided ? React.createElement("span", { role: "status" }, "正在输出 · 当前源会话") : undefined,
  }));
}

test("a linked reply keeps only the authoritative source status, not a second replying label", () => {
  const html = render("running", true);
  assert.match(html, /正在输出 · 当前源会话/);
  assert.doesNotMatch(html, /正在回复/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /继续此工作/);
  assert.match(html, /这是测试正文/);
});

test("without a current source projection, the preview status remains available", () => {
  for (const [status, label] of [["starting", "正在启动"], ["running", "正在回复"], ["waiting_user", "等待你确认"],
    ["done", "已完成"], ["failed", "执行失败"], ["stopped", "已停止"], ["unavailable", "会话不可用"]] as const) {
    const html = render(status);
    assert.match(html, new RegExp(`role="status"[^>]*>${label}`));
    assert.match(html, /继续此工作/);
  }
});
