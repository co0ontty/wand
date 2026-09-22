import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = "tests/web-ui-dark-mode-rules.test.ts";

/**
 * 深色模式当前**未接线**：全仓没有任何 shell 写 data-theme，只有 Appica 的
 * `@custom-variant dark` 和样式选择器在读它。这组测试锁死这个事实，防止
 * （a）无人消费的深色规则重新长回来，（b）有人顺手删掉 Appica 的 variant 契约
 * （那会让 dark: 类退回 Tailwind 默认的 .dark 选择器，等于改变编译产物）。
 */

/** 可能承载 shell 主题生产者的根目录。 */
const PRODUCER_ROOTS = ["src", "scripts", "tests", "android", "ios", "macos", "browser-extension"];

/** 依赖与构建产物目录：不参与扫描。 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "Pods",
  "DerivedData",
  ".gradle",
  ".build",
  ".next",
  ".idea",
]);

/** 只有这些扩展名可能承载 shell 主题代码。 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".kt",
  ".java",
  ".swift",
  ".plist",
  ".xml",
  ".m",
  ".mm",
  ".h",
]);

/**
 * 生产者 = 真正写入 data-theme 的代码。CSS/模板里的 `[data-theme="dark"]`
 * 选择器是消费者，靠 `(?<!\[)` 排除。
 */
const THEME_PRODUCER_PATTERNS: ReadonlyArray<RegExp> = [
  /(?<!\[)\bdata-theme\s*=/,
  /dataset\s*\.\s*theme\s*=/,
  /dataset\s*\[\s*["'`]theme["'`]\s*\]\s*=/,
  /setAttribute\s*\(\s*["'`]data-theme["'`]/,
];

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      // content/ 是 esbuild / tailwind 的生成物，重复源文件里的选择器。
      if (absolutePath === path.join(root, "src", "web-ui", "content")) continue;
      files.push(...collectSourceFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    if (relativePath === self) continue;
    files.push(relativePath);
  }
  return files;
}

test("styles.css 不再保留无人消费的 [data-theme=\"dark\"] 深色规则", () => {
  const styles = source("src/web-ui/content/styles.css");
  assert.ok(
    !styles.includes('data-theme="dark"'),
    "src/web-ui/content/styles.css 不应再出现 [data-theme=\"dark\"] 规则：没有任何 shell 会设置它",
  );
  assert.ok(
    !/\[\s*data-theme/.test(styles),
    "src/web-ui/content/styles.css 不应再按 data-theme 选择器分支",
  );
  // 删的只能是那一条死规则；浅色 token 与 UA 触发的合法深色分支都要留着。
  assert.ok(
    styles.includes("--qb-bg: rgba(255, 255, 255, 0.14);"),
    ".queue-bar 的液态玻璃浅色 token 必须保留",
  );
  assert.ok(
    styles.includes("@media (prefers-color-scheme: dark)"),
    "prefers-color-scheme 分支由 UA 触发，是活代码，不得当作死规则删除",
  );
});

test("全仓没有任何 data-theme 生产者（消费者选择器不算）", () => {
  const producers: string[] = [];
  for (const relativePath of PRODUCER_ROOTS.flatMap((entry) => collectSourceFiles(path.join(root, entry)))) {
    const lines = readFileSync(path.join(root, relativePath), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (THEME_PRODUCER_PATTERNS.some((pattern) => pattern.test(line))) {
        producers.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    producers,
    [],
    `没有任何 shell 设置 data-theme，深色模式未接线：不要留下消费者\n${producers.join("\n")}`,
  );
});

test("appica.css 仍然声明 @custom-variant dark 契约", () => {
  const appica = source("src/web-ui/css/appica.css");
  assert.ok(
    appica.includes("@custom-variant dark (&:is([data-theme=\"dark\"] *, [data-theme=\"dark\"]));"),
    "删除 @custom-variant dark 会让 Appica 的 dark: 类改用 Tailwind 默认 .dark 选择器，改变编译产物",
  );
  assert.ok(
    !appica.includes("Wand renders dark mode through"),
    "appica.css 不得再声明「Wand 通过 data-theme 渲染深色模式」这个与事实不符的契约",
  );
});
