import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("a running process retains exact old bytes and rejects incomplete/corrupt graph replacements", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wand-module-snapshot-"));
  try {
    const script = path.join(dir, "scripts.mjs");
    await build({ entryPoints: ["src/web-ui/scripts.ts"], outfile: script, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    const contentDir = path.join(dir, "content");
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(path.join(contentDir, "scripts.js"), readFileSync("src/web-ui/content/scripts.js"));
    const manifestPath = path.join(contentDir, "module-manifest.json");
    let generation = 0;
    function install(hash: string, text: string, broken = false) {
      const file = `modules/${hash}/runtime.js`, source = `export const version=${JSON.stringify(text)};`;
      mkdirSync(path.dirname(path.join(contentDir, file)), { recursive: true });
      writeFileSync(path.join(contentDir, file), source);
      const manifest = { buildId: hash, entry: file, eager: [file], files: [file], imports: { feature: file },
        dependencies: { [file]: [] }, integrity: { [file]: createHash("sha256").update(broken ? "corrupt" : source).digest("hex") }, generation: ++generation };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      utimesSync(manifestPath, generation, generation);
      return { manifest, source };
    }
    const first = install("1111111111111111", "old");
    const api = await import(pathToFileURL(script).href);
    assert.equal(api.getBrowserModuleManifest().entry, first.manifest.entry);
    const oldBoot = api.getScriptAsset("/tmp/config.json");
    const second = install("2222222222222222", "new-longer");
    assert.equal(api.getBrowserModuleManifest().entry, second.manifest.entry);
    assert.notEqual(api.getScriptAsset("/tmp/config.json").hash, oldBoot.hash);
    assert.equal(api.getBrowserModule(first.manifest.entry), first.source);
    assert.equal(api.getBrowserModule(second.manifest.entry), second.source);
    const invalid = install("3333333333333333", "broken-longer", true);
    assert.equal(api.getBrowserModuleManifest().entry, second.manifest.entry);
    assert.equal(api.getBrowserModule(invalid.manifest.entry), undefined);
    rmSync(path.join(contentDir, second.manifest.entry));
    assert.equal(api.getBrowserModule(second.manifest.entry), second.source, "npm replacement must not lose already snapshotted lazy bytes");
    assert.equal(api.getBrowserModule(first.manifest.entry), first.source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
