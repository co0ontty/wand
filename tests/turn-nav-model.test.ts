import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnNavIndex, turnNavRange, turnPreview, type TurnNavSource } from "../src/web-ui/react/chat/navigation/turn-nav-model.js";

const row = (ownerKey: string | null, visibleText: string, patch: Partial<TurnNavSource> = {}): TurnNavSource =>
  ({ ownerKey, visibleText, visibleIndex: 0, role: "user", ...patch });

test("directory consumes render owners and the renderer's visible body verbatim", () => {
  const json = '{"user":"JSON 正文", "items":[1,2]}';
  assert.deepEqual(buildTurnNavIndex([row("render:one", json), row("render:two", "第二个问题", { visibleIndex: 8 })]), [
    { ownerKey: "render:one", label: "提问 1", preview: json, visibleIndex: 0 },
    { ownerKey: "render:two", label: "提问 2", preview: "第二个问题", visibleIndex: 8 },
  ]);
});

test("unproven, duplicate, notice, placeholder, blank and non-user owners are not targets", () => {
  const entries = buildTurnNavIndex([row(null, "unproven"), row("dup", "first"), row("dup", "second"),
    row("notice", "notice", { notice: true }), row("pending", "queued", { placeholder: true }),
    row("blank", " \n "), row("assistant", "answer", { role: "assistant" }), row("real", "question")]);
  assert.deepEqual(entries.map(entry => entry.ownerKey), ["real"]);
  assert.equal(entries[0]!.label, "提问 1");
});

test("history prepend changes numbering without changing renderer identity", () => {
  const current = [row("stable:a", "A"), row("stable:b", "B")];
  const before = buildTurnNavIndex(current);
  const after = buildTurnNavIndex([row("stable:older", "Earlier"), ...current.map((value, index) => ({ ...value, visibleIndex: index + 1 }))]);
  assert.deepEqual(after.slice(1).map(entry => entry.ownerKey), before.map(entry => entry.ownerKey));
  assert.equal(after[1]!.label, "提问 2");
});

test("previews normalize whitespace, preserve JSON and bound long visible text", () => {
  assert.equal(turnPreview(" A\n B  C "), "A B C");
  assert.equal(turnPreview("[1,2,3]"), "[1,2,3]");
  assert.equal(turnPreview("x".repeat(121)).length, 120);
  assert.ok(turnPreview("x".repeat(121)).endsWith("…"));
});

test("range distinguishes loaded history, server history and unreliable owners, including zero", () => {
  assert.equal(turnNavRange(0, "none"), "当前已载入 0 个提问");
  assert.match(turnNavRange(2, "available"), /原有加载入口/);
  assert.match(turnNavRange(2, "unknown"), /当前提供的历史范围/);
  assert.match(turnNavRange(2, "none", true), /暂无可靠定位标识/);
});
