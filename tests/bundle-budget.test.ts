import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

// Incompressible, deterministic text exercises the real gzip gate without
// depending on generated assets or making the tests invoke a full build.
function chunkText(rows: number): string {
  return Array.from({ length: rows }, (_, index) =>
    createHash("sha256").update(String(index)).digest("hex")).join("\n");
}

function budgetFixture(): { run: (lazy: string) => ReturnType<typeof spawnSync>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wand-budget-test-"));
  const scripts = join(root, "scripts");
  const assets = join(root, "dist", "web-ui");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(new URL("../.nvmrc", import.meta.url), join(root, ".nvmrc"));
  copyFileSync(new URL("../scripts/check-bundle-budget.js", import.meta.url),
    join(scripts, "check-bundle-budget.js"));
  writeFileSync(join(assets, "index.js"),
    'export const renderApp = () => \'<!doctype html><script src="/assets/app.js"></script>\';');
  writeFileSync(join(assets, "styles.js"),
    'export const getStylesAsset = () => ({ content: "body{color:black}" });');
  writeFileSync(join(assets, "embedded-assets.js"),
    'export const EMBEDDED_WEB_ASSETS = { vendor: {} };');
  return {
    run(lazy) {
      writeFileSync(join(assets, "scripts.js"),
        'export const getScriptAsset = () => ({ content: "console.log(1)" });\n' +
        `export const getAiTeamsChunk = () => ({ content: ${JSON.stringify(lazy)} });`);
      return spawnSync(process.execPath, [join(scripts, "check-bundle-budget.js")],
        { encoding: "utf8" });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("employee management fits the lazy allowance without increasing shell transfer", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_000);
  const size = gzipSync(lazy).length;
  assert.ok(size > 35_000 && size <= 40_000, `fixture gzip size: ${size}`);
  const small = fixture.run("");
  const result = fixture.run(lazy);
  assert.equal(small.status, 0, String(small.stderr));
  assert.equal(result.status, 0, String(result.stderr));
  const firstLoad = (stdout: unknown): string | undefined =>
    String(stdout).match(/first load \(HTML \+ app \+ vendor\).*\((\d+) B\)/)?.[1];
  assert.ok(firstLoad(small.stdout));
  assert.equal(firstLoad(result.stdout), firstLoad(small.stdout), "lazy bytes are not shell bytes");
  const repeatHtml = (stdout: unknown): string | undefined =>
    String(stdout).match(/HTML \(repeat\).*\((\d+) B\)/)?.[1];
  assert.ok(repeatHtml(small.stdout));
  assert.equal(repeatHtml(result.stdout), repeatHtml(small.stdout));
});

test("the raised lazy allowance still rejects oversized team chunks", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_200);
  const size = gzipSync(lazy).length;
  assert.ok(size > 40_000, `fixture gzip size: ${size}`);
  const result = fixture.run(lazy);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /\[bundle-budget\] FAILED:/);
  assert.match(String(result.stderr), /ai-teams\.js \(lazy\): \d+ B > 40000 B/);
});
