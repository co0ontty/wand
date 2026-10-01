import assert from "node:assert/strict";
import test from "node:test";

import { isPtySubmitInput } from "../src/pty-turn-activity.js";

test("standalone line terminators are submits", () => {
  // Chat view sends the prompt text and the trailing Enter as separate chunks.
  assert.equal(isPtySubmitInput("\r"), true);
  assert.equal(isPtySubmitInput("\n"), true);
  assert.equal(isPtySubmitInput("\r\n"), true);
  assert.equal(isPtySubmitInput("  \r"), true);
});

test("body text and control sequences are not submits", () => {
  assert.equal(isPtySubmitInput(""), false);
  assert.equal(isPtySubmitInput("hello"), false);
  assert.equal(isPtySubmitInput("hello\r"), false);
  // Pasted multi-line text may still be edited by the TUI; a missed turn start
  // only under-reports activity, while a false start would spin the stop button.
  assert.equal(isPtySubmitInput("line one\nline two"), false);
  assert.equal(isPtySubmitInput("\u0003"), false);
  assert.equal(isPtySubmitInput("\u001b[A"), false);
});
