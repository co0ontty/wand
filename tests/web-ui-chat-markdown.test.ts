import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderChatMarkdown } from "../src/web-ui/markdown.js";

function codeContent(html: string): string {
  const content = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  assert.notEqual(content, undefined, "a fenced code block must render");
  return content!;
}

test("chat code blocks are escaped exactly once and preserve source indentation", () => {
  const code = "  if (left < right && right > 0) {\n    print(\"&amp;\");\n  }\n";
  const html = renderChatMarkdown("```js\n" + code + "```");
  assert.equal(codeContent(html), "  if (left &lt; right &amp;&amp; right &gt; 0) {\n    print(&quot;&amp;amp;&quot;);\n  }\n");
  assert.match(html, /class="code-lang">js<\/span>/);
});

test("Markdown syntax stays literal inside fenced and inline code", () => {
  const code = "# comment\n- old_line\n* literal *\n> redirect\n1. numbered\nhttps://localhost:8080\n[link](/tmp/test.md)\n";
  const html = renderChatMarkdown("```\n" + code + "```\n\n`my_file **value** <b>`");
  assert.equal(codeContent(html), code.replace(/>/g, "&gt;"));
  assert.doesNotMatch(codeContent(html), /<(?:h\d|li|em|blockquote|a)\b/);
  assert.match(html, /<code class="code-inline">my_file \*\*value\*\* &lt;b&gt;<\/code>/);
});

test("unclosed streamed fences render safely and settle into the same code block", () => {
  const partial = renderChatMarkdown("```typescript\nconst url = '<script>';\n");
  const complete = renderChatMarkdown("```typescript\nconst url = '<script>';\n```");
  assert.equal(partial, complete);
  assert.match(partial, /&lt;script&gt;/);
  assert.doesNotMatch(partial, /<script>/);
});

test("code headers show only a real language label and retain the copy hook", () => {
  const unlabelled = renderChatMarkdown("```\ntext\n```");
  assert.match(unlabelled, /class="code-lang"><\/span>/);
  assert.doesNotMatch(unlabelled, /class="code-lang">code</);
  assert.match(unlabelled, /<button type="button" data-antd-control class="code-copy">复制<\/button>/);
  assert.match(renderChatMarkdown("```c++\nint x;\n```"), /class="code-lang">c\+\+<\/span>/);
});

test("chat Markdown keeps its content heading hierarchy under Ant Typography", () => {
  const html = renderChatMarkdown("# One\n\n## Two\n\n### Three\n\n###### Six");
  assert.match(html, /<h2>One<\/h2>/);
  assert.match(html, /<h3>Two<\/h3>/);
  assert.match(html, /<h4>Three<\/h4>/);
  assert.match(html, /<h6>Six<\/h6>/);
  assert.doesNotMatch(html, /<h1\b|<h7\b/);
  const presentation = readFileSync(new URL("../src/web-ui/react/chat/presentation.tsx", import.meta.url), "utf8");
  assert.ok(presentation.includes("return <Typography><OwnedNode node={node}/></Typography>"));
});

test("standard Markdown renders nested lists, blockquotes and intraword underscores", () => {
  const html = renderChatMarkdown("1. First\n   - Child **bold**\n2. Second\n\n> quoted\n> next\n\nmy_file_name *emphasis*");
  assert.match(html, /<ol>[\s\S]*<ul>[\s\S]*Child <strong>bold<\/strong>[\s\S]*<\/ul>[\s\S]*<\/ol>/);
  assert.match(html, /<blockquote>[\s\S]*quoted<br>\s*next[\s\S]*<\/blockquote>/);
  assert.match(html, /my_file_name <em>emphasis<\/em>/);
});

test("tables preserve inline formatting, escaped pipes and alignment", () => {
  const html = renderChatMarkdown("| Left | Right |\n| :--- | ---: |\n| **bold** | a\\|b |\n| `code` | 2 |");
  assert.match(html, /<div class="md-table-wrap"><table class="md-table">/);
  assert.match(html, /<th style="text-align:left">Left<\/th>/);
  assert.match(html, /<td style="text-align:right">a\|b<\/td>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="code-inline">code<\/code>/);
});

test("server file links retain encoded spaces, line suffixes and formatted labels", () => {
  const html = renderChatMarkdown("[**Open** source](</tmp/My Project/source(1).ts:42>)\n\n[File](file:///tmp/My%20Project/readme.md#L12C2)");
  assert.match(html, /class="server-file-link"/);
  assert.match(html, /data-server-file-path="\/tmp\/My Project\/source\(1\)\.ts"/);
  assert.match(html, /path=%2Ftmp%2FMy%20Project%2Fsource\(1\)\.ts/);
  assert.match(html, /<strong>Open<\/strong> source<\/a>/);
  assert.match(html, /data-server-file-path="\/tmp\/My Project\/readme.md"/);
  assert.match(html, /window\.__openFilePreview/);
});

test("HTML files, folders and bare loopback URLs use Wand local preview", () => {
  const html = renderChatMarkdown("[Page](</tmp/My Project/demo.html>) [Folder](/tmp/site/)\n\nhttp://localhost:5173/path?q=1&x=2\n\n[IPv6](http://[::1]:3000/)");
  assert.equal((html.match(/class="local-preview-link"/g) || []).length, 4);
  assert.match(html, /data-local-preview-url="\/tmp\/My Project\/demo.html"/);
  assert.match(html, /href="\/api\/local-file\//);
  assert.match(html, /href="\/api\/local-preview\/127\.0\.0\.1\/5173\/path\?q=1&amp;x=2"/);
  assert.match(html, /window\.__openLocalPreview/);
});

test("external links retain safe targets and local API paths are not file previews", () => {
  const html = renderChatMarkdown("[External](https://example.com/a_(b)?q=1&x=2) [Mail](mailto:a@example.com) [Jump](#part) [API](/api/private)");
  assert.match(html, /href="https:\/\/example.com\/a_\(b\)\?q=1&amp;x=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="mailto:a@example.com"/);
  assert.match(html, /href="#part"/);
  assert.match(html, /<span>API<\/span>/);
  assert.doesNotMatch(html, /data-server-file-path="\/api\//);
});

test("raw HTML and dangerous link protocols never produce executable markup", () => {
  const html = renderChatMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n[JS](javascript:alert(1)) [Data](data:text/html,test) [Remote file](file://example.com/tmp/a.md)');
  assert.doesNotMatch(html, /<(?:img|script)\b|href="(?:javascript:|data:|file:)/i);
  assert.match(html, /&lt;script&gt;/);
  const injected = renderChatMarkdown('[File](</tmp/" onmouseover="alert(1).md>)');
  assert.doesNotMatch(injected, /\sonmouseover="/);
});

test("empty chat Markdown stays empty", () => {
  assert.equal(renderChatMarkdown(""), "");
});
