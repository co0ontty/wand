import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, loadConfigWithStorage, saveConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";

test("structured.processHost is a deployment setting with legacy default and safe persistence", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-config-"));
  const file = path.join(root, "config.json");
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(defaultConfig().structured?.processHost, "legacy");
  writeFileSync(file, JSON.stringify({ structured: { processHost: "rust" } }));
  const configured = await loadConfigWithStorage(file, storage);
  assert.equal(configured.structured?.processHost, "rust");
  await saveConfig(file, configured);
  const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(persisted.structured, { processHost: "rust" });
  writeFileSync(file, JSON.stringify({ structured: { processHost: "auto" } }));
  assert.equal((await loadConfigWithStorage(file, storage)).structured?.processHost, "legacy");
});
