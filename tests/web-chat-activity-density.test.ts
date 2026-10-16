import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activityToolState } from "../src/web-ui/react/conversations/activity.js";

const activity = readFileSync(new URL("../src/web-ui/react/chat/activity.tsx", import.meta.url), "utf8");
const presentation = readFileSync(new URL("../src/web-ui/react/chat/presentation.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/react/chat/styles.ts", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/web-ui/react/conversations/activity.tsx", import.meta.url), "utf8");

test("structured tool return maps only factual receipts to compact states", () => {
  assert.equal(activityToolState(undefined), "pending");
  assert.equal(activityToolState(undefined, { pending: true, is_error: false }), "pending");
  assert.equal(activityToolState(undefined, { pending: false, is_error: false }), "complete");
  assert.equal(activityToolState(undefined, { pending: false, is_error: true }), "error");
  assert.equal(activityToolState({ is_error: false }, { pending: true, is_error: true }), "complete");
  assert.equal(activityToolState({ is_error: true }), "error");
});

test("activity entry keeps one accessible disclosure and state data for manual expansion", () => {
  assert.match(activity, /data-status=\{status\}/);
  assert.match(activity, /data-tool=\{tool \? "true" : undefined\}/);
  assert.match(activity, /aria-expanded=\{expanded\}/);
  assert.match(presentation, /preserveDisclosurePosition\(event\.currentTarget/);
  assert.match(conversation, /onToggle=\{event => preserveDisclosurePosition/);
  assert.match(conversation, /<QuestionCard/);
});

test("readable rows use real icons, meaningful titles and explicit error/pending states", () => {
  assert.match(activity, /WandIcon name=\{icon\}/);
  assert.match(activity, /preview \? <span/);
  assert.match(styles, /\.chat-call-meta/);
  assert.match(styles, /\.chat-call-state\[data-status="pending"\]/);
  assert.match(styles, /\.chat-call-state\[data-status="error"\]/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
});
