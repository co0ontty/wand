import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("header daemon notice preserves focus and confirms manual update, including failure and compact mode", {
  skip: process.env.WAND_DAEMON_BROWSER !== "1",
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/daemon-maintenance-browser.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
