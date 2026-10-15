/*
 * Web transfer budget, measured from the assets actually served by the built
 * package. The HTML is no-store, but app.js/app.css and the vendor assets are
 * content-versioned and browser-cacheable. Count the first load separately
 * from subsequent navigations; ai-teams.js is fetched only when opened.
 *
 * The gate has two tiers so that feature-sized growth never requires editing
 * a number, while real accidents stay blocked:
 *
 * 1. Hard caps (`BUDGET`) are absolute limits with deliberate headroom on the
 *    assets a single navigation or a heavy on-demand feature ships. Crossing
 *    one is a shipping decision: slim the asset, load it on demand, or raise
 *    the cap with the reason spelled out.
 * 2. The ratchet (`RATCHET`) compares firstLoad and the aggregate of all ESM
 *    modules with the committed baseline (scripts/bundle-budget-baseline.json).
 *    Growth within tolerance passes without touching the file; a jump caused
 *    by duplicating a library, losing a code split or dropping a heavy
 *    dependency into the shell fails until `npm run budget:accept` refreshes
 *    the baseline, which lands as a reviewable JSON diff. Refresh it only for
 *    intended growth and note the transfer impact in the commit message.
 *
 * gzip bytes are measured with the Node release pinned in .nvmrc; another
 * Node/zlib release drifts individual assets by a fraction of a percent,
 * which the ratchet tolerance absorbs. All loaded bytes still count; this
 * does not relocate library bytes into an unmetered asset.
 */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { measureBrowserLoadScenarios } from "./browser-transfer-scenarios.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareNodeVersions, nodeBaseline, nodeMinimum } from "./node-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (compareNodeVersions(process.versions.node, nodeMinimum) < 0) {
  console.error(`[bundle-budget] Node >= ${nodeMinimum} is required, got ${process.version}; run \`nvm use\`.`);
  process.exit(1);
}
if (process.versions.node !== nodeBaseline) {
  console.warn(
    `[bundle-budget] measured with Node ${process.version}; the baseline is v${nodeBaseline} (.nvmrc), byte deltas may drift.`,
  );
}

if (!existsSync(path.join(root, "dist", "web-ui", "index.js"))) {
  console.error("[bundle-budget] missing built web assets; run `npm run build` first.");
  process.exit(1);
}

const { renderApp } = await import("../dist/web-ui/index.js");
const { getScriptAsset, getAiTeamsChunk, getPlushAvatarChunk, getThemePreloadAsset, getBrowserModuleManifest, getBrowserModule } = await import("../dist/web-ui/scripts.js");
const { getStylesAsset } = await import("../dist/web-ui/styles.js");
const { EMBEDDED_WEB_ASSETS } = await import("../dist/web-ui/embedded-assets.js");

const configPath = "/tmp/wand-bundle-budget/config.json";
const html = renderApp(configPath);
const js = getScriptAsset(configPath);
const css = getStylesAsset();
const lazy = getAiTeamsChunk();
const modules = getBrowserModuleManifest();
const buildIdentity = EMBEDDED_WEB_ASSETS.buildIdentity;

// Hard caps carry real headroom over the current measurement; growth is caught
// by the ratchet, so these numbers change only when the ceiling itself moves.
const BUDGET = {
  html: 4_096,
  // app.js is only the config/bootstrap script; the ESM graph carries the app.
  js: 4_096,
  // No single lazy module may balloon. Feature-sized growth is the ratchet's job.
  module: 110_000,
  // Legacy CSS is gone (measured ~13 KiB); keep a real boundary, not the stale
  // 110000 B allowance that could never fail.
  css: 64_000,
  // Cold first load: HTML + app.js + CSS + theme + vendors + every eager module.
  // Measured 834841 B (826 KiB); crossing this is a real cold-load decision.
  firstLoad: 900_000,
  // ai-teams.js is fetched only when opening teams; measured 52620 B.
  lazy: 60_000,
  // The 3D identity runtime (Three.js + model) loads only for visible plush
  // avatars; measured 155642 B.
  plush: 175_000,
  theme: 8_192,
};

// Tolerance against the committed baseline, in percent of the baseline with a
// floor that absorbs zlib drift and tiny projects. Growth above it must be
// accepted explicitly with `npm run budget:accept`.
const RATCHET = {
  // The cold path users actually wait on: 2% (or 4 KiB, whichever is larger).
  firstLoad: { percent: 2, floor: 4_096 },
  // Code weight of every ESM module: 5% (or 16 KiB) lets normal features land
  // without touching numbers while blocking relocation or duplication jumps.
  allModules: { percent: 5, floor: 16_384 },
};
const BASELINE_PATH = fileURLToPath(new URL("./bundle-budget-baseline.json", import.meta.url));
const ACCEPT = process.argv.includes("--accept-baseline");

const gzipBytes = (content) => gzipSync(Buffer.from(content, "utf8")).length;
const rawBytes = (content) => Buffer.byteLength(content, "utf8");
const rows = [
  ["HTML (repeat)", html, BUDGET.html],
  ["app.js (cached)", js.content, BUDGET.js],
  ...modules.files.map(file => [`${file} (${modules.eager.includes(file) ? "eager" : "lazy"})`, getBrowserModule(file), modules.eager.includes(file) ? null : BUDGET.module]),
  ["app.css (cached)", css.content, BUDGET.css],
  ["theme.js (cached)", getThemePreloadAsset().content, BUDGET.theme],
  ...Object.entries(EMBEDDED_WEB_ASSETS.vendor).map(([name, asset]) => [name, asset.content, null]),
  ["ai-teams.js (lazy)", lazy.content, BUDGET.lazy],
  ["plush-avatar.js (lazy)", getPlushAvatarChunk().content, BUDGET.plush],
];

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`[bundle-budget] Node ${process.version}, zlib ${process.versions.zlib}:`);
const sizes = new Map();
const rawSizes = new Map();
const failures = [];
const measurements = [];
for (const [name, content, limit] of rows) {
  const gzip = gzipBytes(content);
  const raw = rawBytes(content);
  sizes.set(name, gzip);
  rawSizes.set(name, raw);
  measurements.push({ name, raw, gzip, limit });
  if (buildIdentity && name.startsWith("modules/")) {
    const file = name.replace(/ \((?:eager|lazy)\)$/, "");
    if (createHash("sha256").update(content).digest("hex") !== buildIdentity.artifacts[file]) failures.push(`built module/evidence mismatch: ${file}`);
  }
  if (limit !== null && gzip > limit) {
    failures.push(`${name}: ${gzip} B > ${limit} B (+${gzip - limit} B)`);
  }
}
measurements.sort((a, b) => b.gzip - a.gzip);
for (const { name, gzip } of measurements) console.log(`  ${name.padEnd(31)} gzip ${kib(gzip).padStart(10)} (${gzip} B)`);
if (buildIdentity && modules.buildId !== buildIdentity.moduleBuildId) failures.push("built manifest/evidence identity mismatch");
const loadScenarios = measureBrowserLoadScenarios(modules, measurements);
for (const [name, value] of Object.entries(loadScenarios.scenarios)) console.log(`  scenario ${name.padEnd(24)} gzip ${kib(value.gzip)} (${value.gzip} B)`);
console.log("  scenarios are static estimates, not HAR; firstLoad gate retains all-vendor allowance and excludes optional features.");
const sum = (map, names) => names.reduce((total, name) => total + map.get(name), 0);
const moduleNames = modules.files.map(file => `${file} (${modules.eager.includes(file) ? "eager" : "lazy"})`);
const eagerNames = moduleNames.filter(name => name.includes("(eager)"));
const allModuleBytes = sum(sizes, moduleNames);
const vendorNames = measurements.map(({ name }) => name).filter(name => name.startsWith("/vendor/"));
const vendorBytes = sum(sizes, vendorNames);
const firstLoadBytes = sum(sizes, eagerNames) + sizes.get("HTML (repeat)") + sizes.get("app.js (cached)")
  + sizes.get("app.css (cached)") + sizes.get("theme.js (cached)") + vendorBytes;
const metrics = {
  firstLoad: { gzip: firstLoadBytes, raw: sum(rawSizes, eagerNames) + rawSizes.get("HTML (repeat)") + rawSizes.get("app.js (cached)") + rawSizes.get("app.css (cached)") + rawSizes.get("theme.js (cached)") + sum(rawSizes, vendorNames) },
  allModules: { gzip: allModuleBytes, raw: sum(rawSizes, moduleNames) },
  eagerModules: { gzip: sum(sizes, eagerNames), raw: sum(rawSizes, eagerNames) },
  vendor: { gzip: vendorBytes, raw: sum(rawSizes, vendorNames) },
  html: { gzip: sizes.get("HTML (repeat)"), raw: rawSizes.get("HTML (repeat)") },
  appJs: { gzip: sizes.get("app.js (cached)"), raw: rawSizes.get("app.js (cached)") },
  css: { gzip: sizes.get("app.css (cached)"), raw: rawSizes.get("app.css (cached)") },
  theme: { gzip: sizes.get("theme.js (cached)"), raw: rawSizes.get("theme.js (cached)") },
  aiTeams: { gzip: sizes.get("ai-teams.js (lazy)"), raw: rawSizes.get("ai-teams.js (lazy)") },
  plush: { gzip: sizes.get("plush-avatar.js (lazy)"), raw: rawSizes.get("plush-avatar.js (lazy)") },
};
console.log(`  all ESM modules gzip ${kib(allModuleBytes)} (${allModuleBytes} B)`);
console.log(`  first load (HTML + app + vendor) gzip ${kib(firstLoadBytes)} (${firstLoadBytes} B)`);
if (firstLoadBytes > BUDGET.firstLoad) {
  failures.push(`first load: ${firstLoadBytes} B > ${BUDGET.firstLoad} B (+${firstLoadBytes - BUDGET.firstLoad} B)`);
}
if (/<style\b|<script(?!\s+src=)/i.test(html)) {
  failures.push("the shell must not inline JS or CSS");
}

let baseline = null;
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    if (!ACCEPT) failures.push(`baseline scripts/bundle-budget-baseline.json is unreadable: ${error.message}`);
  }
} else if (!ACCEPT) {
  failures.push("缺少基线 scripts/bundle-budget-baseline.json；运行 npm run budget:accept 生成并随提交保存。");
}
const current = { schema: 1, node: process.version, zlib: process.versions.zlib, metrics };
if (ACCEPT) {
  if (baseline?.metrics) {
    for (const key of Object.keys(RATCHET)) {
      const before = baseline.metrics[key]?.gzip;
      const after = metrics[key].gzip;
      if (typeof before === "number" && before !== after) {
        console.log(`  ${key} 基线刷新: ${before} -> ${after} B (${after - before >= 0 ? "+" : ""}${after - before} B)`);
      }
    }
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log("[bundle-budget] 基线已刷新: scripts/bundle-budget-baseline.json（硬上限仍单独校验）");
  baseline = current;
}
for (const [key, { percent, floor }] of Object.entries(RATCHET)) {
  const base = baseline?.metrics?.[key]?.gzip;
  if (typeof base !== "number") continue;
  const currentBytes = metrics[key].gzip;
  const growth = currentBytes - base;
  const allowed = Math.max(floor, Math.round(base * percent / 100));
  if (growth > allowed) {
    failures.push(
      `${key}: ${currentBytes} B 相对基线 ${base} B 增长 ${growth} B，超过容差 +${allowed} B（+${percent}% 或 +${floor} B 取大）；` +
      "确认增长符合预期后运行 npm run budget:accept 刷新基线并说明首载影响。",
    );
  }
}

const reportDirectory = path.join(root, "output", "web-ui-library-migration");
mkdirSync(reportDirectory, { recursive: true });
const report = {
  buildIdentity, loadScenarios,
  firstLoadDefinition: "conservative shell allowance: HTML + eager ESM + bootstrap + CSS + theme + all terminal/QR vendors; visible avatars and optional features are reported separately",
  node: process.version, zlib: process.versions.zlib, measurements,
  eagerModuleBytes: metrics.eagerModules.gzip, allModuleBytes, vendorBytes, firstLoad: firstLoadBytes,
  firstLoadLimit: BUDGET.firstLoad, acceptedBaseline: ACCEPT,
  baselineGzip: {
    firstLoad: baseline?.metrics?.firstLoad?.gzip ?? null,
    allModules: baseline?.metrics?.allModules?.gzip ?? null,
  },
  failures,
};
writeFileSync(path.join(reportDirectory, "bundle-budget.json"), JSON.stringify(report, null, 2));
if (buildIdentity?.id && /^[a-f0-9]{16}$/.test(buildIdentity.id)) {
  const archive = path.join(reportDirectory, "builds", buildIdentity.id);
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, "bundle-budget.json"), JSON.stringify(report, null, 2));
}
if (failures.length > 0) {
  console.error("\n[bundle-budget] FAILED:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `[bundle-budget] ok - repeat HTML ${kib(sizes.get("HTML (repeat)"))}/${kib(BUDGET.html)}, ` +
    `first load ${kib(firstLoadBytes)}/${kib(BUDGET.firstLoad)}`,
);
