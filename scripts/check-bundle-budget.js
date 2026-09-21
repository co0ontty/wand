/**
 * Bundle budget gate for the inlined web assets.
 *
 * Every byte measured here is shipped inside the single HTML response
 * (`src/web-ui/index.ts` inlines `scripts.js` + `tailwind.css` + `styles.css`
 * into `<style>`/`<script>` tags), so none of it is separately cacheable and
 * all of it is re-transferred on every page load, including a cold mobile
 * WebView start. The vendor bundles are excluded because they are served as
 * separate hashed `<script src>` files and are third-party.
 *
 * Budgets are a ratchet: they may only go down. The migration ADR recorded a
 * 120 KiB increment threshold and a post-migration JS figure of ~268 KB gzip;
 * the bundle has since grown well past both, so the numbers below pin today's
 * reality instead of blessing it. Lower them whenever you can, and only raise
 * one on purpose - in the same commit that raises it, with the reason.
 *
 * Run directly with `npm run check:bundle-budget` (requires a prior build).
 */
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "dist", "web-ui", "content");

/** gzip budgets in bytes, measured over the whole shipped asset. */
const BUDGET = {
  // js 从 512_000 上调（原因必须留在同一提交里，见上）：
  // 「默认迭代 + 用提示词清单生成 commit message」那一版真实增长了约 0.5 KiB
  // （quick-commit 迭代面板 / 仓储 / 类型 + features.ts 样式），把包体顶到
  // 512_140 字节。同一次改动顺手删掉了 mini-keyboard、status-dot/status-text、
  // welcome-input、chat-pin-spacer 这批没有任何生产者的残留（约 0.3 KiB），
  // 仍回不到 512_000，所以按脚本要求刻意上调并记录原因；下一次真正瘦身
  // （懒加载重型面板等）后必须把它降回去。
  js: 514_000,
  css: 100_000,
};

const JS_FILES = ["scripts.js"];
const CSS_FILES = ["styles.css", "tailwind.css"];

function gzipSize(file) {
  const full = path.join(contentDir, file);
  if (!existsSync(full)) {
    console.error(
      `[bundle-budget] missing ${path.relative(root, full)}; run \`npm run build\` first.`,
    );
    process.exit(1);
  }
  const raw = readFileSync(full);
  return { raw: raw.length, gzip: gzipSync(raw).length };
}

function measure(files) {
  return files.reduce(
    (acc, file) => {
      const size = gzipSize(file);
      acc.rows.push({ file, ...size });
      acc.raw += size.raw;
      acc.gzip += size.gzip;
      return acc;
    },
    { rows: [], raw: 0, gzip: 0 },
  );
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

const js = measure(JS_FILES);
const css = measure(CSS_FILES);

console.log("[bundle-budget] inlined web assets (gzip):");
for (const row of [...js.rows, ...css.rows]) {
  console.log(`  ${row.file.padEnd(14)} raw ${kib(row.raw).padStart(10)}  gzip ${kib(row.gzip).padStart(10)}`);
}

const failures = [];
if (js.gzip > BUDGET.js) {
  failures.push(`js   ${kib(js.gzip)} > budget ${kib(BUDGET.js)} (+${kib(js.gzip - BUDGET.js)})`);
}
if (css.gzip > BUDGET.css) {
  failures.push(`css  ${kib(css.gzip)} > budget ${kib(BUDGET.css)} (+${kib(css.gzip - BUDGET.css)})`);
}

if (failures.length > 0) {
  console.error("\n[bundle-budget] FAILED:");
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    "\n  The budget is a ratchet. Either trim the bundle (lazy-load heavy panels,\n" +
      "  drop dead code) or raise BUDGET in scripts/check-bundle-budget.js in this\n" +
      "  same commit and state why in the commit message.",
  );
  process.exit(1);
}

console.log(
  `[bundle-budget] ok - js ${kib(js.gzip)}/${kib(BUDGET.js)}, css ${kib(css.gzip)}/${kib(BUDGET.css)}`,
);
