import { transformSync } from "esbuild";

/**
 * minify 浏览器 JS（scripts.js）。esbuild 只重命名局部标识符、不动字符串字面量内容，
 * 因此 scripts.ts 注入用的 ${escapeHtml(configPath)} 占位符（在双引号字符串里）会原样保留。
 */
export function minifyJs(code) {
  return transformSync(code, { loader: "js", minify: true, target: "es2017", legalComments: "none" }).code;
}

/** minify CSS（styles.css）。 */
export function minifyCss(code) {
  return transformSync(code, { loader: "css", minify: true, legalComments: "none" }).code;
}
