import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { AiTeamRunDetail } from "../src/ai-team-types.js";
import type { ConversationTurn } from "../src/types.js";
import { enrichStructuredMessages } from "../src/structured-client-protocol.js";
import { configureTeamChatComposerRuntime } from "../src/web-ui/react/ai-teams/composer-bridge.js";
import { formatFilePreviewSize } from "../src/web-ui/react/file-preview/model.js";
import { TeamChatView, chatTurnFingerprint } from "../src/web-ui/react/ai-teams/team-chat-view.js";

const turn: ConversationTurn = {
  role: "assistant", author: { id: "dev", name: "开发", sessionId: "member" },
  createdAt: "2026-10-01T09:00:00.000Z",
  content: [{ type: "text", text: "✅ 完成「实现报告」\n\n不会在卡片显示的正文" }],
  reportFile: { stepId: "step-1", path: "/tmp/wand-report/报告 & 结果.md", name: "报告 & 结果.md", size: 2048,
    preview: { title: "输入恢复验收报告", excerpt: "六种界面验证通过。\n草稿与发送契约保持完整。" } },
};

test("file card replaces all report text and offers authenticated preview/download", (t) => {
  t.after(configureTeamChatComposerRuntime({
    read: () => ({ text: "", attachments: [], revision: 0 }),
    edit: () => false, subscribe: () => () => {},
    submit: async (_id, text, deliver) => deliver({ text, attachments: [] }),
  }));
  const detail = {
    run: { id: "run", status: "done", chatSessionId: "chat", objective: "报告验收", team: { name: "测试团队", members: [] }, stepsUsed: 1, stepLimit: 8 },
    steps: [], chatTurns: [turn], memberStates: {},
  } as unknown as AiTeamRunDetail;
  const html = renderToStaticMarkup(createElement(TeamChatView, { detail, onChange: () => {} }));
  assert.match(html, /team-chat-file-card/);
  assert.match(html, /报告 &amp; 结果.md/);
  assert.match(html, /Markdown · 2.0 KB/);
  assert.match(html, /title="查看完整报告：输入恢复验收报告"/);
  assert.match(html, /六种界面验证通过。/);
  assert.match(html, /team-chat-file-excerpt/);
  assert.match(html, /team-chat-file-icon" aria-hidden="true"/);
  assert.ok(!html.includes("不会在卡片显示的正文"));
  assert.ok(!html.includes("team-chat-preview"));
  assert.ok(!html.includes("点击展开"));
  const legacy = { ...turn, reportFile: { ...turn.reportFile!, preview: undefined } };
  const legacyHtml = renderToStaticMarkup(createElement(TeamChatView, {
    detail: { ...detail, chatTurns: [legacy] }, onChange: () => {},
  }));
  assert.match(legacyHtml, /点击查看完整报告/);
  assert.ok(!legacyHtml.includes("六种界面验证通过"));
});

test("file metadata participates in message identity and survives structured transport", () => {
  const enriched = enrichStructuredMessages([turn], "chat");
  assert.deepEqual(enriched[0]!.reportFile, turn.reportFile);
  assert.notEqual(chatTurnFingerprint(turn), chatTurnFingerprint({ ...turn, reportFile: { ...turn.reportFile!, size: 4096 } }));
  assert.notEqual(chatTurnFingerprint(turn), chatTurnFingerprint({ ...turn, reportFile: { ...turn.reportFile!, stepId: "step-2" } }));
  assert.notEqual(chatTurnFingerprint(turn), chatTurnFingerprint({ ...turn,
    reportFile: { ...turn.reportFile!, preview: { ...turn.reportFile!.preview!, excerpt: "新的摘录" } } }));
});

test("relay report attachments survive persistence without starting a provider", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-report-relay-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null);
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const session = manager.createRelaySession({ cwd: root, mode: "full-access", provider: "pi", automationId: "ai-team-chat:report", title: "测试群" });
  const posted = manager.appendRelayTurns(session.id, [turn])!;
  assert.deepEqual(posted.messages![0]!.reportFile, turn.reportFile);
  assert.deepEqual(storage.getSession(session.id)!.messages![0]!.reportFile, turn.reportFile);
  assert.deepEqual(storage.getSession(session.id)!.messages![0]!.content, turn.content);
  assert.equal(posted.structuredState!.inFlight, false);
});

test("file size formatting uses original byte size including empty files", () => {
  assert.equal(formatFilePreviewSize(0), "0 B");
  assert.equal(formatFilePreviewSize(1023), "1023 B");
  assert.equal(formatFilePreviewSize(1024), "1.0 KB");
  assert.equal(formatFilePreviewSize(1024 * 1024), "1.0 MB");
});
