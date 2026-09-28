import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// chat-render.ts 依赖浏览器运行环境，单测里只能按源码契约锁定这两个渲染陷阱：
// 1) 代码块被转义两次，`&&` / `<` / `>` 显示成 `&amp;&amp;` / `&lt;` / `&gt;`；
// 2) 代码行参与按行处理的行首规则，`# 注释`、`- 旧行` 被改写成标题、列表、引用。
const chatRender = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = chatRender.indexOf(startMarker);
  const end = chatRender.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `找不到 ${startMarker} … ${endMarker} 之间的源码`);
  return chatRender.slice(start, end);
}

test("chat code blocks are escaped exactly once", () => {
  const highlightCode = section("function highlightCode(code, lang) {", "export function shortCommand");
  assert.doesNotMatch(
    highlightCode,
    /&amp;/,
    "highlightCode 的入参已由 escapeHtml 处理，再转义一次会让 & < > 显示成实体",
  );
  assert.match(
    chatRender,
    /var result = escapeHtml\(stashMarkdownLinks\(String\(text\)\)\);/,
    "renderMarkdown 仍然只做一次整体转义",
  );
});

test("markdown line rules never rewrite code block lines", () => {
  assert.match(
    chatRender,
    /var protectedHighlighted = highlighted\.replace\(\/\\n\/g, codeNewline\)/,
    "代码块内的换行必须先换成占位符，否则行首的 - / * / # / > / 1. 规则会命中代码行",
  );
  assert.match(
    chatRender,
    /result\.split\(codeNewline\)\.join\(newline\)/,
    "渲染结束前必须把占位符换回真换行，否则代码块会挤成一行",
  );
});

test("code block header only shows a real language label", () => {
  assert.doesNotMatch(
    chatRender,
    /\(lang \|\| "code"\)/,
    "没有语言标注时不要伪造 code 作为语言名",
  );
  assert.match(
    chatRender,
    /'<span class="code-lang">' \+ \(lang \? escapeHtml\(lang\) : ""\)/,
    "语言标注留空占位即可",
  );
});

// 一屏的最高级标题属于页面本身（面包屑末段 / 对话框标题），气泡里的 `# ` 不能再占 h1。
test("chat markdown headings never claim the page title's h1", () => {
  assert.doesNotMatch(chatRender, /'<h1>'/, "renderMarkdown 不再产出 h1");
  assert.match(
    chatRender,
    /replaceLinePrefix\(result, "# ", '<h2>', '<\/h2>'\)/,
    "`# ` 下移成 h2",
  );
  assert.match(
    chatRender,
    /replaceLinePrefix\(result, "## ", '<h3>', '<\/h3>'\)/,
    "`## ` 下移成 h3（既有 .markdown-content h3 字号档）",
  );
  assert.match(
    chatRender,
    /replaceLinePrefix\(result, "### ", '<h4>', '<\/h4>'\)/,
    "`### ` 用真 h4（.markdown-content h4 有自己的字号档），不再借 aria-level",
  );
  assert.doesNotMatch(chatRender, /replaceLinePrefix\(result, "### ", '<h3 role="heading"/, "`### ` 不再借 h3 + aria-level 冒充层级");
  // 降级不许丢字号：这四档是 .markdown-content 唯一的字号梯度，缺一条 h4 就会掉进
  // tailwind preflight 的 font-size: inherit，第三级标题退化成正文。
  const sheet = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(
    sheet,
    /\.markdown-content h4 \{\s*margin: 16px 0 8px 0;\s*font-weight: 600;\s*font-size: 13\.3px;/,
    "h4 有独立一档字号，且沿用该组的间距与字重",
  );
  for (const [tag, size] of [["h1", "17.5"], ["h2", "15.4"], ["h3", "14"]] as const) {
    assert.match(
      sheet,
      new RegExp(`\\.markdown-content ${tag} \\{ font-size: ${size}px; \\}`),
      `${tag} 这一档的声明值必须还是原样（本批只加 h4，不改既有三档）`,
    );
  }
  // 顺序不能变：### 必须最先替换，否则 ## / # 会抢走同一行的前缀。
  assert.ok(
    chatRender.indexOf('replaceLinePrefix(result, "### "') < chatRender.indexOf('replaceLinePrefix(result, "## "'),
    "三级标题要先于二级替换",
  );
  assert.ok(
    chatRender.indexOf('replaceLinePrefix(result, "## "') < chatRender.indexOf('replaceLinePrefix(result, "# "'),
    "二级标题要先于一级替换",
  );
});

test("code copy button speaks the site language", () => {
  assert.match(chatRender, /'<button class="code-copy">复制<\/button>'/);
  assert.doesNotMatch(chatRender, /Copied!|>Copy</, "代码块复制按钮不再留英文成句");
  // 点击处理器按 class 取按钮，改写文案不影响绑定；复位后的文案同样要是中文。
  assert.doesNotMatch(chatRender, /textContent = "Copy"/, "复制完成后不能把文案改回英文");
  assert.equal((chatRender.match(/textContent = "已复制"/g) ?? []).length, 3,
    "两处代码块复制按钮 + 一处消息气泡复制按钮");
});
