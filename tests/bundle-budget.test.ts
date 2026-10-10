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
  copyFileSync(new URL("../scripts/node-version.js", import.meta.url),
    join(scripts, "node-version.js"));
  writeFileSync(join(assets, "index.js"),
    'export const renderApp = () => \'<!doctype html><script src="/assets/app.js"></script>\';');
  writeFileSync(join(assets, "styles.js"),
    'export const getStylesAsset = () => ({ content: "body{color:black}" });');
  writeFileSync(join(assets, "embedded-assets.js"),
    'export const EMBEDDED_WEB_ASSETS = { vendor: {} };');
  return {
    run(lazy) {
      writeFileSync(join(assets, "scripts.js"),
        'export const getThemePreloadAsset = () => ({ content: "console.log(2)" });\n' +
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

test("employee invitations fit the new lazy boundary without becoming shell bytes", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_280);
  const size = gzipSync(lazy).length;
  assert.ok(size > 44_000 && size <= 46_000, `fixture gzip size: ${size}`);
  const small = fixture.run("");
  const result = fixture.run(lazy);
  assert.equal(small.status, 0, String(small.stderr));
  assert.equal(result.status, 0, String(result.stderr));
  const firstLoad = (stdout: unknown): string | undefined =>
    String(stdout).match(/first load \(HTML \+ app \+ vendor\).*\((\d+) B\)/)?.[1];
  const shellBytes = firstLoad(small.stdout);
  assert.ok(shellBytes, "the actual shell byte count must be reported");
  assert.equal(firstLoad(result.stdout), shellBytes);
});

test("delivery overview fits only its on-demand allowance", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_330);
  const size = gzipSync(lazy).length;
  assert.ok(size > 46_000 && size <= 48_000, `fixture gzip size: ${size}`);
  const small = fixture.run("");
  const result = fixture.run(lazy);
  assert.equal(small.status, 0, String(small.stderr));
  assert.equal(result.status, 0, String(result.stderr));
  const firstLoad = (stdout: unknown): string | undefined =>
    String(stdout).match(/first load \(HTML \+ app \+ vendor\).*\((\d+) B\)/)?.[1];
  const bytes = firstLoad(small.stdout);
  assert.ok(bytes);
  assert.equal(firstLoad(result.stdout), bytes);
});

test("the raised lazy allowance still rejects oversized team chunks", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_500);
  const size = gzipSync(lazy).length;
  assert.ok(size > 52_000, `fixture gzip size: ${size}`);
  const result = fixture.run(lazy);
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /\[bundle-budget\] FAILED:/);
  assert.match(String(result.stderr), /ai-teams\.js \(lazy\): \d+ B > 52000 B/);
});

test("无指派派工的名单面板只吃新的按需额度，不进主包", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  // 48,000–52,000 B 区间：旧额度会拒、现额度接受（层阶与上一条一致）。
  const lazy = chunkText(1_440);
  const size = gzipSync(lazy).length;
  assert.ok(size > 48_000 && size <= 52_000, `fixture gzip size: ${size}`);
  const small = fixture.run("");
  const result = fixture.run(lazy);
  assert.equal(result.status, 0, String(result.stderr));
  const firstLoad = (stdout: unknown): string | undefined =>
    String(stdout).match(/first load \(HTML \+ app \+ vendor\).*\((\d+) B\)/)?.[1];
  const shellBytes = firstLoad(small.stdout);
  assert.ok(shellBytes, "必须报出真实首载字节数");
  assert.equal(firstLoad(result.stdout), shellBytes, "按需包的字节不进首载");
});
