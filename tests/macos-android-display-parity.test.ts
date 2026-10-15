import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { resolveEmployeeAvatar } from "../src/plush-avatar.js";
const base = new URL("../macos/Wand/", import.meta.url);
const available = existsSync(new URL("ContactAvatar.swift", base));
test("macOS avatar display consumes latest Android canonical portraits and local runtime", { skip: !available }, () => {
  const mac = new URL("Assets.xcassets/", base);
  const android = new URL("../android/app/src/main/assets/plush/", import.meta.url);
  if (!existsSync(android)) return;
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const files = readdirSync(android).filter(file => file.startsWith("plush") && file.endsWith(".png"));
  assert.equal(files.length, 327);
  for (const file of files) assert.equal(hash(readFileSync(new URL(file.replace(".png", ".imageset/") + file, mac))), hash(readFileSync(new URL(file, android))), file);
  const manifest = JSON.parse(readFileSync(new URL("PlushScene/source-hashes.json", base), "utf8")) as { sources: Record<string, string> };
  for (const [file, expected] of Object.entries(manifest.sources)) assert.equal(hash(readFileSync(new URL("../" + file, import.meta.url))), expected, file);
  const source = readFileSync(new URL("FocusComposer.swift", base), "utf8");
  // Portraits stay shared; desktop composer geometry now follows Web, not mobile.
  assert.match(source, /controlRadius: CGFloat = 8/);
  assert.match(source, /overlay\(alignment: \.top\)/);
  assert.match(source, /maximumTextHeight: CGFloat = 112/);
  assert.match(source, /awaitingAck/);
  assert.match(source, /recovery/);
});
test("reference avatar semantics lock actual system cats before uploads and accept dog token", () => {
  assert.deepEqual(resolveEmployeeAvatar({ id:"e_wand_default", systemKey:"wand-default", avatar:"data:image/png;base64,eA==" }), { version:1, kind:"cat", coat:"silver" });
  assert.deepEqual(resolveEmployeeAvatar({ id:"e_wand_ops", systemKey:"wand-ops", avatar:"cat:7" }), { version:1, kind:"cat", coat:"orange" });
  assert.deepEqual(resolveEmployeeAvatar({ id:"e_hr", avatar:"plush-dog:v1:shiba:red-scarf" }), { version:1, kind:"dog", breed:"shiba", scarf:"red" });
});
