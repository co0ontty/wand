import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as toolActivity from "../src/web-ui/browser/tool-activity.js";

function renderActivity(blocks: unknown[], pendingCommandId = "cmd", expanded = false): string {
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
        getPersistedExpandState: () => expanded,
      };
      if (id === "./utils") return { escapeHtml: (value: unknown) => String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;") };
      if (id === "./i18n") return { iconSvg: () => "" };
      return fallback;
    },
    window: { matchMedia: () => ({ matches: false }) },
    document: { addEventListener: noop },
    setTimeout: noop, clearTimeout: noop,
    fetch: () => { throw new Error("Opening the timeline must never fetch tool details"); },
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
  assert.match(html, /<span class="chat-activity-meta"><time class="chat-activity-command-time"/,
    "collapsed summary leads with the command time");
  assert.match(html, /运行中/);
  assert.doesNotMatch(html, /thinking-inline/);
  assert.match(html, /chat-activity-entry-detail" inert aria-hidden="true"/);
  assert.doesNotMatch(html, /Private reasoning text|More private reasoning/);
});

test("completed command keeps its real time but has no running animation", () => {
  const html = renderActivity([
    { type: "thinking", thinking: "reasoning" },
    { type: "tool_use", id: "cmd", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:03:10Z",
    } },
  ], "");
  assert.match(html, /chat-activity-command-time/);
  assert.match(html, /<span class="chat-activity-meta"><time class="chat-activity-command-time"/);
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
  assert.match(html, /data-thinking-entry="true"/);
});

test("expanded timeline shows every call identity in order, with no detail bodies or prefetch", () => {
  const html = renderActivity([
    { type: "tool_use", id: "read", name: "Read", activity: {
      kind: "read_file", label: "查看 src/main.ts", fileKey: "same", occurredAt: "2026-09-30T12:00:00Z",
    }, input: { file_path: "src/main.ts", private: "do-not-render" } },
    { type: "tool_use", id: "run", name: "Bash", activity: { kind: "run_command", label: "运行命令 · Bash" } },
    { type: "tool_use", id: "edit", name: "Edit", activity: { kind: "edit_file", label: "修改 src/main.ts", fileKey: "same" } },
    { type: "tool_use", id: "edit-again", name: "Edit", activity: { kind: "edit_file", label: "修改 src/main.ts", fileKey: "same" } },
  ], "", true);
  assert.equal((html.match(/class="chat-activity-entry"/g) ?? []).length, 4);
  assert.match(html, /chat-activity-timeline" role="list"/);
  const timeline = html.slice(html.indexOf('class="chat-activity-timeline"'));
  assert.ok(timeline.indexOf("查看 src/main.ts") < timeline.indexOf("运行命令 · Bash"));
  assert.ok(timeline.indexOf("运行命令 · Bash") < timeline.indexOf("修改 src/main.ts"));
  assert.match(html, /修改了1个文件/);
  assert.match(html, /chat-activity-entry-time" datetime="2026-09-30T12:00:00Z"/);
  assert.ok(html.indexOf('class="chat-activity-entry-time"') <
    html.indexOf('class="chat-activity-entry-label"'), "invocation time precedes the file/tool summary");
  assert.doesNotMatch(html, /do-not-render|<pre|tool-use-card|chat-activity-group-title/);
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
  assert.equal((html.match(/chat-activity-command-time/g) ?? []).length, 1, "the time appears once, at the line head");
  assert.match(html, /class="chat-activity-command-elapsed" data-started-at="2026-09-30T12:00:00Z"/);
});
