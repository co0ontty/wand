import assert from "node:assert/strict";
import test from "node:test";

import { cliIsForeground, parsePtyForegroundRows, samplePtyForegrounds } from "../src/pty-foreground.js";

test("parses ps rows and tolerates blank / junk lines", () => {
  const rows = parsePtyForegroundRows(
    "  93940  93940  96786\n\n96786 96786 96786\n  \ngarbage line\n1 2\n",
  );
  assert.deepEqual(rows, [
    { pid: 93940, pgid: 93940, tpgid: 96786 },
    { pid: 96786, pgid: 96786, tpgid: 96786 },
  ]);
});

test("a foreground process group that is not the shell's own means a CLI is in front", () => {
  // shell 93940 is waiting on the CLI (pi) in group 96786
  assert.equal(cliIsForeground({ pid: 93940, pgid: 93940, tpgid: 96786 }), true);
  // idle prompt: the shell itself is the foreground group
  assert.equal(cliIsForeground({ pid: 93940, pgid: 93940, tpgid: 93940 }), false);
  // no controlling terminal
  assert.equal(cliIsForeground({ pid: 26413, pgid: 36840, tpgid: 0 }), false);
});

test("unsupported platforms and empty pid lists report unknown instead of guessing", async () => {
  assert.equal(await samplePtyForegrounds([1], { platform: "win32" }), null);
  assert.equal(await samplePtyForegrounds([], { platform: "darwin" }), null);
  // Negative / non-integer pids must not reach ps.
  assert.equal(await samplePtyForegrounds([0, -1, Number.NaN], { platform: "darwin" }), null);
});

test("samples the live process table through ps", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("ps sampling only implemented on darwin/linux");
    return;
  }
  // This test process is not a session leader with a controlling terminal in CI,
  // so only assert the shape: our own pid resolves to a boolean.
  const samples = await samplePtyForegrounds([process.pid]);
  assert.ok(samples === null || typeof samples.get(process.pid) === "boolean");
});
