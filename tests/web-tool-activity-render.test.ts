import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as toolActivity from "../src/web-ui/browser/tool-activity.js";
import * as toolDetail from "../src/web-ui/browser/tool-activity-detail.js";

function renderActivity(
  blocks: unknown[], pendingCommandId = "cmd", expanded = false,
  live = true, latestAssistantIndex = 1,
): string {
  const source = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8") + `
    export function renderActivityFixture(blocks, pendingId, live, latestAssistantIndex) {
      _currentMessageGlobalIndex = 1;
      _currentLatestAssistantMessageIndex = latestAssistantIndex;
      _currentActivitySessionBusy = live;
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
      if (id === "./tool-activity-detail.js") return toolDetail;
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
  return exports.renderActivityFixture(blocks, pendingCommandId, live, latestAssistantIndex);
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
  assert.match(html, /chat-call-detail" inert aria-hidden="true"/);
  assert.doesNotMatch(html, /Private reasoning text|More private reasoning/);
});

test("completed command keeps its real time but has no running animation", () => {
  const html = renderActivity([
    { type: "thinking", thinking: "reasoning" },
    { type: "tool_use", id: "cmd", activity: {
      kind: "run_command", occurredAt: "2026-09-30T12:03:10Z",
    } },
  ], "", false, false);
  assert.match(html, /is-history/);
  assert.doesNotMatch(html, /chat-process-summary-dot/);
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
  assert.match(html, /chat-process-summary-dot/);
  assert.doesNotMatch(html, /is-history/);
});

test("live timed thinking shows duration and silence while history and legacy reasoning stay untimed", () => {
  const block = { type: "thinking", thinking: "", occurredAt: "2026-10-06T05:00:00Z", lastActivityAt: "2026-10-06T05:01:00Z" };
  const live = renderActivity([block], "");
  assert.match(live, /正在思考/);
  assert.match(live, /data-activity-kind="thinking" data-started-at="2026-10-06T05:00:00Z" data-last-activity-at="2026-10-06T05:01:00Z"/);
  assert.match(live, /无新进展/);
  const history = renderActivity([{ ...block, thinking: "previous thought" }], "", false, false);
  assert.doesNotMatch(history, /data-activity-kind="thinking"|正在思考|无新进展/);
  const legacy = renderActivity([{ type: "thinking", thinking: "" }], "");
  assert.doesNotMatch(legacy, /data-activity-kind="thinking"|无新进展/);
});

test("older thinking stays a text-only history summary while a newer reply runs", () => {
  const html = renderActivity([{ type: "thinking", thinking: "Previous reasoning" }], "", false, true, 2);
  assert.match(html, /is-history/);
  assert.doesNotMatch(html, /chat-process-summary-dot|正在思考|Previous reasoning/);
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
  assert.equal((html.match(/class="chat-call"/g) ?? []).length, 4);
  assert.match(html, /chat-activity-timeline" role="list"/);
  const timeline = html.slice(html.indexOf('class="chat-activity-timeline"'));
  assert.ok(timeline.indexOf("查看 src/main.ts") < timeline.indexOf("运行命令 · Bash"));
  assert.ok(timeline.indexOf("运行命令 · Bash") < timeline.indexOf("修改 src/main.ts"));
  assert.match(html, /修改了1个文件/);
  assert.match(html, /data-occurred-at="2026-09-30T12:00:00Z"/);
  assert.match(html, /data-label="查看 src\/main\.ts"[^>]*data-time="[^"]+"/, "real clock and call label reach the library presentation together");
  assert.doesNotMatch(html, /do-not-render|<pre|tool-use-card|chat-activity-group-title/);
});

test("a reasoning round that produced no text is not a timeline entry", () => {
  const blocks = [
    { type: "thinking", thinking: "" },
    { type: "tool_use", id: "cmd", activity: { kind: "run_command", label: "运行命令" } },
    { type: "thinking", thinking: "   " },
  ];
  // 历史态：两块空轮次夹在调用之间，没有产出过正文，时间线上都不该占一行。
  const history = renderActivity(blocks, "", false, false);
  assert.equal((history.match(/class="chat-call"/g) ?? []).length, 1);
  assert.doesNotMatch(history, /深度思考/);
  // 段尾那一块可以是正在进行的一轮，仍然保留占位并说明在思考。
  const live = renderActivity(blocks, "", true);
  assert.equal((live.match(/class="chat-call"/g) ?? []).length, 2);
  assert.match(live, /正在思考/);
  assert.deepEqual(toolActivity.thinkingRounds([
    { block: { type: "thinking", thinking: "" }, index: 0 },
    { block: { type: "tool_use", id: "cmd" }, index: 1 },
    { block: { type: "thinking", thinking: "有正文" }, index: 2 },
  ]).map(round => round.ordinal), [1]);
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

test("every thinking block is one round and only multi-round runs carry a position", () => {
  const rounds = toolActivity.thinkingRounds([
    { block: { type: "thinking", thinking: "先想想" }, index: 0 },
    { block: { type: "tool_use", id: "todo" }, index: 1 },
    { block: { type: "thinking", thinking: "再想想" }, index: 2 },
    { block: { type: "thinking", thinking: "继续想" }, index: 3 },
  ]);
  assert.deepEqual(rounds.map(round => [round.ordinal, round.total, round.call.index]),
    [[1, 3, 0], [2, 3, 2], [3, 3, 3]]);
  assert.deepEqual(rounds.map(round => toolActivity.thinkingRoundLabel(round)),
    ["深度思考 1/3", "深度思考 2/3", "深度思考 3/3"]);
  assert.equal(toolActivity.thinkingRoundLabel(undefined), "深度思考");
  const single = toolActivity.thinkingRounds([{ block: { type: "thinking", thinking: "一轮" }, index: 0 }]);
  assert.equal(toolActivity.thinkingRoundLabel(single[0]), "深度思考");
  const html = renderActivity([
    { type: "thinking", thinking: "第一轮推理" },
    { type: "tool_use", id: "todo", activity: { kind: "other", label: "调用 Pi/todo" } },
    { type: "thinking", thinking: "第二轮推理" },
  ], "", true);
  assert.match(html, /data-label="深度思考 1\/2"/);
  assert.match(html, /data-label="深度思考 2\/2"/);
});

test("only the newest unfinished call or the last round is live, never both", () => {
  const items = [
    { block: { type: "thinking", thinking: "一" }, index: 0 },
    { block: { type: "tool_use", id: "run" }, index: 1 },
    { block: { type: "thinking", thinking: "二" }, index: 2 },
  ];
  // 命令还没回执：活跃的是它，前后的思考轮次都不再转。
  assert.deepEqual(toolActivity.activityLiveRow(items, "run", true), { kind: "call", call: items[1] });
  assert.equal(toolActivity.activityLiveRow(items, null, true)?.kind, "thinking");
  assert.equal(toolActivity.activityLiveRow(items, null, true)?.round?.ordinal, 2);
  // 历史段没有活跃条目：位置猜测也不该点亮最后一轮。
  assert.equal(toolActivity.activityLiveRow(items, "run", false), null);
  assert.equal(toolActivity.activityLiveRow(items, null, false), null);
});

test("the compact summary keeps the only running mark, expanded or not", () => {
  const blocks = [{ type: "thinking", thinking: "推理中", occurredAt: "2026-10-06T05:00:00Z" }];
  assert.match(renderActivity(blocks, "", false), /chat-process-summary-dot/);
  const expanded = renderActivity(blocks, "", true);
  assert.match(expanded, /chat-process-summary-dot/,
    "展开后缩略统计行仍然承担唯一的动态 loading");
  assert.equal((expanded.match(/chat-process-summary-dot/g) ?? []).length, 1,
    "同一段里只有摘要行带动态标记");
  assert.equal((expanded.match(/data-status="running"/g) ?? []).length, 1, "exactly one entry is running");
});
