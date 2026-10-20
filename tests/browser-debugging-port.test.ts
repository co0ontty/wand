import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPublishedChromePort } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("Chrome readiness waits for a fully published valid port, not just an existing empty/partial file", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-chrome-port-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "DevToolsActivePort");
  assert.equal(readPublishedChromePort(file), null);
  for (const contents of ["", "12", "0\n", "65536\n", "not-ready\n"]) {
    writeFileSync(file, contents); assert.equal(readPublishedChromePort(file), null);
  }
  writeFileSync(file, "12345\n/devtools/browser/offline-fixture");
  assert.equal(readPublishedChromePort(file), "12345");
});
