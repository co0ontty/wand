import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("session header omits duplicate metadata across phases, shells, and widths", {
  skip: process.env.WAND_TOPBAR_BROWSER !== "1", timeout: 90_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/shell-topbar-browser.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 80_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
