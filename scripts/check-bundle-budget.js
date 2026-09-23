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
  // js 历史上从 512_000 上调过三次，每次都在本文件记录原因：
  //   1) 「默认迭代 + 用提示词清单生成 commit message」：quick-commit 迭代面板 /
  //      仓储 / 类型 + features.ts 样式真实增长约 0.5 KiB（顶到 512_140），同一次
  //      删掉了 mini-keyboard、status-dot/status-text、welcome-input、chat-pin-spacer
  //      等无生产者残留（约 0.3 KiB）仍回不到 512_000，于是上调到 514_000。
  //   2) 结构化模式「读图内联展示」修复：工具卡有内联结果图时不再重复渲染路径
  //      缩略图（同一张图只出一个）。净增约 1 字节 gzip，但 gzip 对齐使 514_000
  //      这个精确卡点反复红（±1~3 字节漂移），故上调到 514_200 留 200 字节余量。
  //   3) 任务看板「父子任务」+ 排队消息可编辑：看板卡片/列表的父任务胶囊、详情页
  //      父任务链接与子任务区块、新建/详情两处父任务选择器、input.ts 排队条「编辑」
  //      按钮，都是真实功能，不是重复渲染（esbuild metafile 对账：本批只动了
  //      task-board-host.tsx / task-board-agent.ts / task-board-views.tsx / input.ts
  //      四个文件，其余模块字节数不变）。minify 后 gzip 514_130 -> 515_168（+1.0 KiB），
  //      514_200 这个卡点本就只剩 70 字节余量，于是上调到 516_000。
  // 下一次真正瘦身（懒加载重型面板等）后必须把这几个值一起降回去。
  // 已知的最大单块肥肉：tailwind-merge（bundle 内 ~103 KiB raw，由 @appica/ui-react
  // 的 cn() 间接引入）与 react-dom（~553 KiB raw）；真要瘦身从这两处下手。
  js: 516_000,
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
