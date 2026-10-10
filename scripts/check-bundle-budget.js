/*
 * Web transfer budget, measured from the assets actually served by the built
 * package. The HTML is no-store, but app.js/app.css and the vendor assets are
 * content-versioned and browser-cacheable. Count the first load separately
 * from subsequent navigations; ai-teams.js is fetched only when opened.
 *
 * Ant Design 6.6.5 / X 2.9.0 are shared from the main bundle (including their
 * generated component-style code), never duplicated in the team chunk.
 * Foundation measurement on Node 26.10.0, when that release was the pinned
 * baseline (it moved to the 24.21.0 LTS; packaged asset bytes do not depend on
 * the runtime): JS 896,271 B, CSS 74,553 B,
 * vendor 112,008 B, HTML 1,014 B; cold 1,083,846 B gzip. Preallocated dirty
 * baseline embedded assets: JS 572,308 B, CSS 101,297 B; same vendor bytes.
 * The JS increase is 323,963 B; CSS drops 26,744 B after removing Appica's
 * generated styles. Cold transfer rises 297,220 B (37.8%). HTML stays tiny;
 * content-versioned app/vendor/team assets retain the existing cache contract.
 * The new main/cold limits leave about 5% headroom. All loaded bytes still
 * count; this does not relocate library bytes into an unmetered asset.
 */
import { gzipSync } from "node:zlib";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareNodeVersions, nodeBaseline } from "./node-version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (compareNodeVersions(process.versions.node, nodeBaseline) < 0) {
  console.error(`[bundle-budget] Node >= ${nodeBaseline} is required, got ${process.version}; run \`nvm use\`.`);
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
const { getScriptAsset, getAiTeamsChunk, getPlushAvatarChunk, getThemePreloadAsset } = await import("../dist/web-ui/scripts.js");
const { getStylesAsset } = await import("../dist/web-ui/styles.js");
const { EMBEDDED_WEB_ASSETS } = await import("../dist/web-ui/embedded-assets.js");

const configPath = "/tmp/wand-bundle-budget/config.json";
const html = renderApp(configPath);
const js = getScriptAsset(configPath);
const css = getStylesAsset();
const lazy = getAiTeamsChunk();

// The first-load limit includes the terminal and QR assets, which the shell
// requests unconditionally. Do not silently move bytes out of the inline
// budget into these files. The optional team chunk has its own limit.
const BUDGET = {
  html: 4_096,
  // 工作区新建会话增加任务选择、名称和失败重试绑定：约增加 1 KB gzip（0.1%）。
  // 主包预留这一功能的 1472 B；首屏总预算、按需包与全部资源计数保持。
  // 顶部组件更新入口、确认中断与失败反馈：本轮实测主包 941931 B。
  // 增加 1472 B（0.16%）额度；首屏总预算、按需包与缓存契约保持。
  // 紧凑执行表单、真实配置摘要、文件检索范围与草稿/浮层保护：
  // 本轮主包 949459 B gzip，相对 943040 B 上限增加 6419 B（0.68%）。
  // 主包额度增加 9280 B（0.98%），首屏 1140000 B 与所有资源计数保持。
  // 五套本机主题与紧凑预览使主包 951390→953141 B gzip（+1751 B）。
  // 主题首屏资产另计 2185 B；仅主包增加 3072 B 额度，首载总预算保持 1140000 B。
  // Geometric plush identity adapter, static fallback, and reversible picker:
  // measured 960,390 B gzip (+4,998 B beyond prior allowance). +8,192 B
  // leaves ~3KB headroom; Three.js/model stay in the separately metered lazy asset.
  // Employee profile editing and avatar workspace: measured 964,862 B gzip
  // on Node 24.21.0 and 26.10.0, 1,278 B above the previous allowance.
  // Add 2,048 B (0.21%) for the shared editor; cold-load budget stays 1,140,000 B
  // (actual 1,092,331 B), with all shell/vendor bytes and cache rules unchanged.
  js: 965_632,
  css: 110_000,
  firstLoad: 1_140_000,
  // The team chunk now also contains employee management and candidate editors.
  // Measured gzip: 38,007 B (was capped at 35,000 B); 40,000 B leaves ~5% headroom.
  // This changes only the on-demand allowance (+5,000 B), not the shell's cold
  // load or repeat HTML budgets. Opening a team/chat page fetches the chunk once;
  // its content-versioned URL remains browser-cacheable until the bytes change.
  // 团队报告增加真实标题、三行摘录与文本缩略图：实测 39960→40201 B gzip。
  // 仅打开团队时下载并按内容指纹缓存，不增加首载；其它预算保持不变。
  // 每员工独立知识库面板仅按需加载：实测 42,586 B，比上轮多937 B，首载不变。
  // 员工标签编辑/校验与原位反馈：实测 43,674 B gzip，按需上限 43,000→44,000 B。
  // 当前首载 750,957 B、复访 HTML 1,014 B；首载/主包预算不放宽，内容指纹缓存保持。
  // 员工原位入群/替换/解绑：43,674→45,569 B gzip（+1,895 B，约4.3%），仍只按需加载。
  // 共享员工名单可见性保护与 Select triggerRef 使主包/首载仅 +121 B；CSS/复访 HTML 不变。
  // 仅按需上限 44,000→46,000 B；主包/CSS/首载门限与内容指纹缓存契约不变。
  // 交付/接力概览与完整快照合并只进按需包：45,569→47,523 B gzip（+1,954 B）。
  // 同输入counterfactual主JS543,093 B/CSS99,057 B不变，首载仅内容指纹HTML字节差异。
  // 仅按需上限46,000→48,000 B；主JS/CSS/首载门限与内容指纹缓存仍不放宽。
  // 无指派派工（决策选人 → 建议名单 → 确认开工）第一版只进按需包：50187 B gzip（+2664 B）。
  // 随后把流程与名单区提到主包共享（react/team-dispatch/roster.tsx），供通讯录面板、
  // 看板新建任务、任务详情指派三处复用：主包 544407→547223 B（+2816 B）、按需包回落到 48851 B
  // （−1336 B），CSS 与 vendor 不变，首载 759486→762475 B（+2989 B）。三处共用一份规则，
  // 不再各自长；按需上限保持 48,000→52,000 B，主包/CSS/首载门限仍不放宽。
  // Employee directory/profile changes: measured 52,873 B gzip, 873 B above
  // the prior allowance. Add 2,000 B (3.85%) only to this on-demand chunk.
  // It remains content-versioned and cached; it does not enter the cold shell.
  lazy: 54_000,
  // True 3D identity runtime (Three.js + model) is requested only for visible
  // plush avatars. Measure it explicitly rather than hiding it in vendor bytes.
  // Measured 145,152 B gzip with Three.js 0.186.1; ~6% headroom.
  plush: 153_600,
};
const gzipBytes = (content) => gzipSync(Buffer.from(content, "utf8")).length;
const rows = [
  ["HTML (repeat)", html, BUDGET.html],
  ["app.js (cached)", js.content, BUDGET.js],
  ["app.css (cached)", css.content, BUDGET.css],
  ["theme.js (cached)", getThemePreloadAsset().content, 8_192],
  ...Object.entries(EMBEDDED_WEB_ASSETS.vendor).map(([name, asset]) => [name, asset.content, null]),
  ["ai-teams.js (lazy)", lazy.content, BUDGET.lazy],
  ["plush-avatar.js (lazy)", getPlushAvatarChunk().content, BUDGET.plush],
];

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`[bundle-budget] Node ${process.version}, zlib ${process.versions.zlib}:`);
const sizes = new Map();
const failures = [];
const measurements = [];
for (const [name, content, limit] of rows) {
  const gzip = gzipBytes(content);
  sizes.set(name, gzip);
  measurements.push({ name, raw: Buffer.byteLength(content, "utf8"), gzip, limit });
  console.log(`  ${name.padEnd(31)} gzip ${kib(gzip).padStart(10)} (${gzip} B)`);
  if (limit !== null && gzip > limit) {
    failures.push(`${name}: ${gzip} B > ${limit} B (+${gzip - limit} B)`);
  }
}
const vendorBytes = [...sizes.entries()].filter(([name]) => name.startsWith("/vendor/"))
  .reduce((total, [, size]) => total + size, 0);
const firstLoad = sizes.get("HTML (repeat)") + sizes.get("app.js (cached)")
  + sizes.get("app.css (cached)") + sizes.get("theme.js (cached)") + vendorBytes;
console.log(`  first load (HTML + app + vendor) gzip ${kib(firstLoad)} (${firstLoad} B)`);
if (firstLoad > BUDGET.firstLoad) {
  failures.push(`first load: ${firstLoad} B > ${BUDGET.firstLoad} B (+${firstLoad - BUDGET.firstLoad} B)`);
}
if (/<style\b|<script(?!\s+src=)/i.test(html)) {
  failures.push("the shell must not inline JS or CSS");
}
const reportDirectory = path.join(root, "output", "web-ui-library-migration");
mkdirSync(reportDirectory, { recursive: true });
writeFileSync(path.join(reportDirectory, "bundle-budget.json"), JSON.stringify({
  node: process.version, zlib: process.versions.zlib, measurements,
  vendorBytes, firstLoad, firstLoadLimit: BUDGET.firstLoad, failures,
}, null, 2));
if (failures.length > 0) {
  console.error("\n[bundle-budget] FAILED:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `[bundle-budget] ok - repeat HTML ${kib(sizes.get("HTML (repeat)"))}/${kib(BUDGET.html)}, ` +
    `first load ${kib(firstLoad)}/${kib(BUDGET.firstLoad)}`,
);
