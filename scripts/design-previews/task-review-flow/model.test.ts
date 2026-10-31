import assert from "node:assert/strict";
import test from "node:test";
import { samples, transition } from "./model.ts";

test("交付 → AI 验收 → 人工确认归档，AI 不冒充用户接受", () => {
  const review = transition(samples[0], "submit", "交付版本与报告", "");
  assert.equal(review.stage, "review");
  assert.equal(review.aiPassed, false);
  const ready = transition(review, "pass", "真实验收证据", "");
  assert.equal(ready.stage, "ready");
  assert.equal(ready.aiPassed, true);
  assert.equal(ready.humanAccepted, false);
  const archived = transition(ready, "archive", ready.evidence, "");
  assert.equal(archived.stage, "archived");
  assert.equal(archived.humanAccepted, true);
  assert.equal(archived.history.length, 4);
});
test("AI 不通过保留证据与缺口，修复并重新提交才能再验收", () => {
  const failed = transition(samples[1], "fail", "复现证据", "窄屏按钮不可达");
  assert.equal(failed.stage, "doing");
  assert.equal(failed.gap, "窄屏按钮不可达");
  assert.equal(failed.evidence, "复现证据");
  assert.throws(() => transition(failed, "submit", failed.evidence, failed.gap));
  const review = transition(failed, "submit", "修复证据", "");
  assert.equal(review.stage, "review");
  assert.match(review.history.join("\n"), /窄屏按钮不可达/);
});
test("人工退回使 AI 通过失效，但不抹除历史", () => {
  const returned = transition(samples[2], "return", "交付证据", "体验仍有问题");
  assert.equal(returned.stage, "doing");
  assert.equal(returned.aiPassed, false);
  assert.equal(returned.humanAccepted, false);
  assert.equal(returned.history.length, 2);
  assert.throws(() => transition(returned, "archive", "交付证据", ""));
});
test("无证据、有缺口、无原因、跨阶段、伪造 ready 都不能通过", () => {
  assert.throws(() => transition(samples[0], "submit", " ", ""));
  assert.throws(() => transition(samples[1], "pass", "证据", "尚未真机验收"));
  assert.throws(() => transition(samples[1], "pass", "", ""));
  assert.throws(() => transition(samples[1], "fail", "证据", ""));
  assert.throws(() => transition(samples[2], "return", "证据", ""));
  assert.throws(() => transition(samples[0], "pass", "证据", ""));
  assert.throws(() => transition(samples[1], "archive", "证据", ""));
  assert.throws(() => transition({ ...samples[2], aiPassed: false }, "archive", "证据", ""));
  assert.throws(() => transition(samples[2], "archive", "证据", "有缺口"));
});
