import assert from "node:assert/strict";
import test from "node:test";
import { idleSpeechEligible } from "../src/web-ui/react/speech/hold-input.ts";

test("mobile hold-to-talk is reserved for empty idle input, not editing, IME or desktop selection", () => {
  assert.equal(idleSpeechEligible("", false, false, true), true);
  for (const args of [["", true, false, true], ["", false, true, true], ["draft", false, false, true],
    [" ", false, false, true], ["", false, false, false], ["", false, false, true, true]] as const) {
    assert.equal(idleSpeechEligible(...args), false);
  }
});
