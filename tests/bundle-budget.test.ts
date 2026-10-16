import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface FixtureOptions {
  lazy?: string;
  plush?: string;
  modules?: { eager: string; lazy: string[] };
}

function budgetFixture(): {
  run: (options?: FixtureOptions) => ReturnType<typeof spawnSync>;
  accept: (options?: FixtureOptions) => ReturnType<typeof spawnSync>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "wand-budget-test-"));
  const scripts = join(root, "scripts");
  const assets = join(root, "dist", "web-ui");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(assets, { recursive: true });
  const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", engines }));
  copyFileSync(new URL("../.nvmrc", import.meta.url), join(root, ".nvmrc"));
  copyFileSync(new URL("../scripts/check-bundle-budget.js", import.meta.url),
    join(scripts, "check-bundle-budget.js"));
  copyFileSync(new URL("../scripts/node-version.js", import.meta.url),
    join(scripts, "node-version.js"));
  copyFileSync(new URL("../scripts/browser-transfer-scenarios.js", import.meta.url),
    join(scripts, "browser-transfer-scenarios.js"));
  writeFileSync(join(assets, "index.js"),
    'export const renderApp = () => \'<!doctype html><script src="/assets/app.js"></script>\';');
  writeFileSync(join(assets, "styles.js"),
    'export const getStylesAsset = () => ({ content: "body{color:black}" });');
  writeFileSync(join(assets, "embedded-assets.js"),
    'export const EMBEDDED_WEB_ASSETS = { vendor: {} };');
  const spawn = (accept: boolean, options: FixtureOptions) => {
    const { lazy = "", plush = "console.log(3)", modules = { eager: "", lazy: [] } } = options;
    const files = Object.fromEntries([["modules/runtime.js", modules.eager],
      ...modules.lazy.map((content, index) => [`modules/feature${index}.js`, content])]);
    writeFileSync(join(assets, "scripts.js"),
      `const files = ${JSON.stringify(files)};\n` +
      'export const getBrowserModuleManifest = () => ({ entry: "modules/runtime.js", files: Object.keys(files), eager: ["modules/runtime.js"] });\n' +
      'export const getBrowserModule = file => files[file];\n' +
      'export const getThemePreloadAsset = () => ({ content: "console.log(2)" });\n' +
      'export const getScriptAsset = () => ({ content: "console.log(1)" });\n' +
      `export const getAiTeamsChunk = () => ({ content: ${JSON.stringify(lazy)} });\n` +
      `export const getPlushAvatarChunk = () => ({ content: ${JSON.stringify(plush)} });`);
    return spawnSync(process.execPath,
      [join(scripts, "check-bundle-budget.js"), ...(accept ? ["--accept-baseline"] : [])],
      { encoding: "utf8" });
  };
  return {
    run: (options = {}) => spawn(false, options),
    accept: (options = {}) => spawn(true, options),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const firstLoad = (stdout: unknown): string | undefined =>
  String(stdout).match(/first load \(HTML \+ app \+ vendor\).*\((\d+) B\)/)?.[1];

test("缺少基线时预算门禁失败并给出生成命令", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /\[bundle-budget\] FAILED:/);
  assert.match(String(result.stderr), /bundle-budget-baseline\.json/);
  assert.match(String(result.stderr), /budget:accept/);
});

test("功能级按需包通过：字节不进首载，也不需要改预算文件", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_000);
  const size = gzipSync(lazy).length;
  assert.ok(size > 35_000 && size <= 40_000, `fixture gzip size: ${size}`);
  assert.equal(fixture.accept({ lazy }).status, 0);
  const small = fixture.run();
  const result = fixture.run({ lazy });
  assert.equal(small.status, 0, String(small.stderr));
  assert.equal(result.status, 0, String(result.stderr));
  const shellBytes = firstLoad(small.stdout);
  assert.ok(shellBytes, "必须报出真实首载字节数");
  assert.equal(firstLoad(result.stdout), shellBytes, "按需包的字节不进首载");
  assert.match(String(result.stdout), /ai-teams\.js \(lazy\)/);
});

test("3D 运行时单独计量，不进首载", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const plush = chunkText(4_000);
  assert.ok(gzipSync(plush).length <= 175_000, "fixture must fit the plush cap");
  assert.equal(fixture.accept({ plush }).status, 0);
  const small = fixture.run({ plush: "" });
  const result = fixture.run({ plush });
  assert.equal(small.status, 0, String(small.stderr));
  assert.equal(result.status, 0, String(result.stderr));
  assert.ok(firstLoad(small.stdout));
  assert.equal(firstLoad(result.stdout), firstLoad(small.stdout));
  assert.match(String(result.stdout), /plush-avatar\.js \(lazy\)/);
});

test("超限 3D 运行时被硬上限拒绝", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  assert.equal(fixture.accept().status, 0);
  const plush = chunkText(5_200);
  assert.ok(gzipSync(plush).length > 175_000, "fixture must exceed the plush cap");
  const result = fixture.run({ plush });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /plush-avatar\.js \(lazy\): \d+ B > 175000 B/);
});

test("刷新基线不绕过硬上限：超限按需块仍被拒绝", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const lazy = chunkText(1_900);
  assert.ok(gzipSync(lazy).length > 60_000, "fixture must exceed the lazy cap");
  const accepted = fixture.accept({ lazy });
  assert.equal(accepted.status, 1, "accept must not bypass hard caps");
  assert.match(String(accepted.stderr), /ai-teams\.js \(lazy\): \d+ B > 60000 B/);
  const result = fixture.run({ lazy });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /ai-teams\.js \(lazy\): \d+ B > 60000 B/);
});

test("eager 模块计入首载硬上限，不再有单独的主包上限", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const eager = chunkText(26_000);
  assert.ok(gzipSync(eager).length > 900_000, "fixture must exceed the first-load cap");
  fixture.accept({ modules: { eager, lazy: [] } });
  const result = fixture.run({ modules: { eager, lazy: [] } });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /first load: \d+ B > 900000 B/);
  assert.doesNotMatch(String(result.stderr), /runtime\.js \(eager\):/);
  assert.doesNotMatch(String(result.stderr), /相对基线/, "accepted baseline must silence the ratchet");
});

test("首载棘轮：小幅波动放行，超过 2%（下限 4 KiB）要求显式接受", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const baseline = chunkText(1_500);
  assert.equal(fixture.accept({ modules: { eager: baseline, lazy: [] } }).status, 0);
  const withinTolerance = fixture.run({ modules: { eager: `${baseline}\n${chunkText(30)}`, lazy: [] } });
  assert.equal(withinTolerance.status, 0, String(withinTolerance.stderr));
  const grown = fixture.run({ modules: { eager: `${baseline}\n${chunkText(200)}`, lazy: [] } });
  assert.equal(grown.status, 1);
  assert.match(String(grown.stderr), /firstLoad: \d+ B 相对基线 \d+ B 增长 \d+ B/);
  assert.match(String(grown.stderr), /budget:accept/);
});

test("全量棘轮：功能级增长通过，异常膨胀要求刷新基线，刷新后通过", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const chunks = Array.from({ length: 8 }, (_, index) => chunkText(2_700 + index));
  assert.equal(fixture.accept({ modules: { eager: "", lazy: chunks } }).status, 0);
  const featureSized = fixture.run({ modules: { eager: "", lazy: [...chunks, chunkText(200)] } });
  assert.equal(featureSized.status, 0, String(featureSized.stderr));
  const jump = [...chunks, chunkText(1_600)];
  const oversized = fixture.run({ modules: { eager: "", lazy: jump } });
  assert.equal(oversized.status, 1);
  assert.match(String(oversized.stderr), /allModules: \d+ B 相对基线 \d+ B 增长 \d+ B/);
  assert.match(String(oversized.stderr), /budget:accept/);
  assert.equal(fixture.accept({ modules: { eager: "", lazy: jump } }).status, 0);
  assert.equal(fixture.run({ modules: { eager: "", lazy: jump } }).status, 0);
});

test("单个按需模块仍有 110000 B 硬上限", (t) => {
  const fixture = budgetFixture();
  t.after(fixture.cleanup);
  const oversized = chunkText(3_500);
  assert.ok(gzipSync(oversized).length > 110_000, "fixture must exceed the module cap");
  fixture.accept({ modules: { eager: "", lazy: [oversized] } });
  const result = fixture.run({ modules: { eager: "", lazy: [oversized] } });
  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /feature0\.js \(lazy\): \d+ B > 110000 B/);
  assert.doesNotMatch(String(result.stderr), /first load: \d+ B >/);
});
