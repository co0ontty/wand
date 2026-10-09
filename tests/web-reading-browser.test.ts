import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("reading controls preserve width and usage preferences and open tool screenshots by keyboard", {
  skip: process.env.WAND_READING_BROWSER !== "1", timeout: 120_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/web-reading-browser.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 110_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
