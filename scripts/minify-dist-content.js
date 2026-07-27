// 在 build:copy-content 把 src/web-ui/content 拷进 dist 之后，就地 minify dist 副本里的
// scripts.js / styles.css（vendor bundle 已是 minify 产物，不再处理）。src 源保持可读，
// dev 模式（直接读 src）不受影响。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minifyJs, minifyCss } from "./minify-web-assets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "dist", "web-ui", "content");

const jsPath = path.join(dir, "scripts.js");
const cssPath = path.join(dir, "styles.css");
const jsBefore = readFileSync(jsPath, "utf8");
const cssBefore = readFileSync(cssPath, "utf8");
const jsAfter = minifyJs(jsBefore);
const cssAfter = minifyCss(cssBefore);
writeFileSync(jsPath, jsAfter, "utf8");
writeFileSync(cssPath, cssAfter, "utf8");
const pct = (a, b) => `${(b.length / 1024).toFixed(0)}KB→${(a.length / 1024).toFixed(0)}KB`;
console.log(`[minify-dist-content] scripts.js ${pct(jsAfter, jsBefore)}, styles.css ${pct(cssAfter, cssBefore)}`);
