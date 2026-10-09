import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatActivity, ChatActivityEntry } from "../src/web-ui/react/chat/activity.js";
import { ChatMessage } from "../src/web-ui/react/chat/message.js";
import { conversationForRun } from "../src/web-ui/react/conversations/run-route.js";
import type { ConversationSummary } from "../src/conversation-types.js";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

test("all Web chat adapters use one library message renderer", () => {
  const files = sourceFiles("src/web-ui/react");
  assert.deepEqual(files.filter(file => /<Bubble(?:\s|>|\.)/.test(readFileSync(file, "utf8"))), ["src/web-ui/react/chat/message.tsx"]);
  for (const file of ["chat/presentation.tsx", "ai-teams/team-chat-view.tsx", "conversations/session-preview.tsx", "composer-voice/host.tsx"]) {
    assert.match(readFileSync(`src/web-ui/react/${file}`, "utf8"), /<ChatMessage\b/, file);
  }
  for (const own of [false, true]) for (const surface of ["message", "document", "preview"] as const) {
    const html = renderToStaticMarkup(React.createElement(ChatMessage, { own, surface, content: "共有正文", header: "署名", footer: "状态" }));
    assert.equal((html.match(/data-chat-renderer="canonical"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`data-chat-role="${own ? "user" : "assistant"}"`));
    for (const text of ["共有正文", "署名", "状态"]) assert.ok(html.includes(text));
  }
});

test("legacy run routing resolves only explicit ownership and rejects ambiguous matching", () => {
  const run = { id: "run-1", conversationId: undefined, chatSessionId: "session-1" };
  const group = { id: "group-1", kind: "group", sessionId: "session-1", tasks: [] } as unknown as ConversationSummary;
  assert.equal(conversationForRun({ ...run, conversationId: "explicit" }, [group]), "explicit");
  assert.equal(conversationForRun(run, [group]), "group-1");
  assert.equal(conversationForRun(run, [{ ...group, kind: "dm" }]), null);
  assert.equal(conversationForRun(run, [group, { ...group, id: "group-2" }]), null);
  assert.equal(conversationForRun({ ...run, chatSessionId: undefined }, [group]), null);
  const byTask = { ...group, sessionId: undefined, tasks: [{ runs: [{ id: "run-1" }] }] } as unknown as ConversationSummary;
  assert.equal(conversationForRun(run, [byTask]), "group-1");
  assert.equal(conversationForRun({ ...run, id: "other" }, [byTask]), null);
});

test("normal sessions and IM share execution disclosure and entry rendering", () => {
  for (const file of ["chat/presentation.tsx", "conversations/activity.tsx"]) {
    const source = readFileSync(`src/web-ui/react/${file}`, "utf8");
    assert.match(source, /<ChatActivity\b/); assert.match(source, /<ChatActivityEntry\b/);
  }
  const summary = renderToStaticMarkup(React.createElement(ChatActivity, { expanded: false, summary: "过程", onToggle() {}, children: "正文" }));
  assert.match(summary, /data-chat-activity-renderer="canonical"/); assert.match(summary, /inert=""/);
  const entry = renderToStaticMarkup(React.createElement(ChatActivityEntry, { expanded: true, status: "error", label: "工具", stateLabel: "失败", preview: "输入", result: "失败原因", tool: true, onToggle() {}, children: "详情" }));
  assert.match(entry, /data-chat-entry-renderer="canonical"/);
  for (const text of ["工具，失败", "输入", "失败原因", "详情"]) assert.ok(entry.includes(text));
  const panel = readFileSync("src/web-ui/react/issues/team-run-panel.tsx", "utf8");
  assert.doesNotMatch(panel, /<TeamChatView/); assert.match(panel, /<ConversationMessages/);
});
