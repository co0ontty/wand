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
