import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as toolActivity from "../src/web-ui/browser/tool-activity.js";

function renderActivity(blocks: unknown[], pendingCommandId = "cmd"): string {
  const source = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8") + `
    export function renderActivityFixture(blocks, pendingId) {
      _currentMessageGlobalIndex = 1;
      _currentLatestAssistantMessageIndex = 1;
      _currentActivitySessionBusy = true;
      _currentLatestPendingCommandId = pendingId;
      state.selectedId = "session";
      return buildSegmentBlocksHtml(blocks, 0, "assistant", {}, "msg:1");
    }
  `;
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  runInNewContext(code, {
    exports,
    require: (id: string) => {
      if (id === "./tool-activity") return toolActivity;
      if (id === "./state") return { state: { selectedId: "session", toolContentCache: {}, sessions: [] } };
      if (id === "./chat-scroll") return {
        buildExpandKey: (kind: string, parts: unknown[]) => `${kind}:${parts.join(":")}`,
        getPersistedExpandState: () => null,
      };
      if (id === "./utils") return { escapeHtml: (value: unknown) => String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") };
      if (id === "./i18n") return { iconSvg: () => "" };
      return fallback;
    },
    window: { matchMedia: () => ({ matches: false }) },
    document: { addEventListener: noop },
    setTimeout: noop, clearTimeout: noop,
  });
  return exports.renderActivityFixture(blocks, pendingCommandId);
}

test("adjacent thinking and command share one inline activity with hidden process text", () => {
  const html = renderActivity([
    { type: "thinking", thinking: "  Private reasoning text\n" },
    { type: "tool_use", id: "cmd", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:03:10Z",
    } },
    { type: "thinking", thinking: "More private reasoning" },
  ]);
  assert.equal((html.match(/class="chat-activity(?:\s|\")/g) ?? []).length, 1);
  assert.match(html, /深度思考/);
  assert.match(html, /运行了1条命令/);
  assert.match(html, /is-command-running/);
  assert.match(html, /<time class="chat-activity-command-time" datetime="2026-09-30T12:03:10Z"/);
  assert.match(html, /运行中/);
  assert.doesNotMatch(html, /thinking-inline/);
  assert.match(html, /chat-activity-entry-detail" hidden>.*  Private reasoning text\n/s);
});

test("completed command keeps its real time but has no running animation", () => {
  const html = renderActivity([
    { type: "thinking", thinking: "reasoning" },
    { type: "tool_use", id: "cmd", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:03:10Z",
    } },
  ], "");
  assert.match(html, /chat-activity-command-time/);
  assert.doesNotMatch(html, /is-command-running|已等待|chat-activity-command-indicator/);
});

test("old command history without a timestamp does not invent one", () => {
  const html = renderActivity([
    { type: "tool_use", id: "cmd", activity: { kind: "run_command" } },
  ], "");
  assert.match(html, /运行了1条命令/);
  assert.doesNotMatch(html, /chat-activity-command-time|chat-activity-command-elapsed/);
});

test("an empty live thinking placeholder shows a status until its text arrives", () => {
  const html = renderActivity([{ type: "thinking", thinking: "" }], "");
  assert.match(html, /正在思考/);
  assert.match(html, /思考内容尚未到达/);
});

test("latest event clock and waiting duration can refer to different commands", () => {
  const html = renderActivity([
    { type: "tool_use", id: "older-pending", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:00:00Z",
    } },
    { type: "tool_use", id: "newer-completed", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:03:10Z",
    } },
  ], "older-pending");
  assert.match(html, /<time class="chat-activity-command-time" datetime="2026-09-30T12:03:10Z"/);
  assert.match(html, /class="chat-activity-command-elapsed" data-started-at="2026-09-30T12:00:00Z"/);
});
