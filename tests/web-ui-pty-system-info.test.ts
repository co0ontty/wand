import assert from "node:assert/strict";
import test from "node:test";

import { shouldExtractPtySystemInfo } from "../src/web-ui/browser/pty-system-info.js";

test("PTY system info is extracted only for terminal sessions", () => {
  assert.equal(shouldExtractPtySystemInfo({ sessionKind: "pty", runner: "pty" }), true);
  assert.equal(
    shouldExtractPtySystemInfo({ sessionKind: "structured", runner: "codex-cli-exec" }),
    false,
  );
});

test("known structured runners remain protected when legacy data omits sessionKind", () => {
  assert.equal(shouldExtractPtySystemInfo({ runner: "qoder-cli-print" }), false);
  assert.equal(shouldExtractPtySystemInfo({ runner: "claude-cli-print" }), false);
});
