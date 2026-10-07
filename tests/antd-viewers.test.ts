import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownPreview } from "../src/web-ui/react/file-preview/markdown.tsx";
import {
  parseFilePreviewMarkdown,
  tokenizeFilePreviewMarkdownInline,
} from "../src/web-ui/react/file-preview/model.ts";

const SHARED_SHEETS = [
  "src/web-ui/content/styles.css",
  "src/web-ui/react/styles/base.ts",
  "src/web-ui/react/styles/features.ts",
];

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("Marked 承担 Markdown 解析：危险协议只留文本，原始 HTML 不成立", () => {
  const inline = tokenizeFilePreviewMarkdownInline(
    "[js](javascript:alert(1)) [vbs](vbscript:alert(2)) [mail](mailto:a@b.c) "
    + "[hash](#part) [rel](/docs/a.md) [web](https://example.com)",
  );
  const hrefs = inline.flatMap((token) => token.type === "link" ? [token.url] : []);
  assert.deepEqual(hrefs, ["mailto:a@b.c", "#part", "/docs/a.md", "https://example.com"]);
  assert.ok(!inline.some((token) => token.type === "link" && /^(?:javascript|vbscript):/i.test(token.url)));
  // The rejected destinations are downgraded to their label, not dropped.
  assert.ok(inline.some((token) => token.type === "text" && token.value === "js"));
  assert.ok(inline.some((token) => token.type === "text" && token.value === "vbs"));

  const images = tokenizeFilePreviewMarkdownInline(
    "![bad](javascript:alert(1)) ![data](data:image/png;base64,AAAA) ![remote](https://example.com/a.png)",
  );
  const sources = images.flatMap((token) => token.type === "image" ? [token.url] : []);
  assert.deepEqual(sources, ["data:image/png;base64,AAAA", "https://example.com/a.png"]);
});

test("Marked 解析保留视图契约：标题、表格对齐、代码语言、原始 HTML 与嵌套强调", () => {
  const blocks = parseFilePreviewMarkdown([
    "# Title",
    "",
    "| left | right |",
    "| :--- | ---: |",
    "| one | two |",
    "",
    "```ts extra",
    "const x = 1;",
    "```",
    "",
    "<script>alert(1)</script>",
    "",
    "- [x] done",
    "- plain **bold *nested***",
    "",
    "para line one",
    "para line two",
  ].join("\n"));

  assert.deepEqual(blocks.map((block) => block.type), ["heading", "table", "code", "paragraph", "list", "paragraph"]);
  const table = blocks[1];
  assert.equal(table.type, "table");
  if (table.type === "table") {
    assert.deepEqual(table.aligns, ["left", "right"]);
    assert.deepEqual(
      table.rows[0].map((cell) => cell.map((token) => token.value).join("")),
      ["one", "two"],
    );
  }
  const code = blocks[2];
  assert.equal(code.type, "code");
  if (code.type === "code") {
    // Only the language word is used; the trailing info string is dropped.
    assert.equal(code.lang, "ts");
    assert.equal(code.value, "const x = 1;");
  }
  const html = blocks[3];
  assert.equal(html.type, "paragraph");
  if (html.type === "paragraph") {
    // Raw HTML stays literal text: the renderer must never build an element from it.
    assert.deepEqual(html.content, [{ type: "text", value: "<script>alert(1)</script>" }]);
  }
  const list = blocks[4];
  assert.equal(list.type, "list");
  if (list.type === "list") {
    assert.equal(list.items.length, 2);
    // GFM task markers survive as text; nested emphasis flattens to its label.
    assert.equal(list.items[0].map((token) => token.value).join(""), "[x] done");
    assert.deepEqual(
      list.items[1].map((token) => `${token.type}:${token.value}`),
      ["text:plain ", "strong:bold nested"],
    );
  }
  // Soft line breaks inside one paragraph stay visible as newlines (pre-wrap styles).
  const paragraph = blocks[5];
  assert.equal(paragraph.type, "paragraph");
  if (paragraph.type === "paragraph") {
    assert.equal(paragraph.content.map((token) => token.value).join(""), "para line one\npara line two");
  }
});

test("Markdown 预览由 React 拥有 DOM：没有 h1、没有可执行 HTML、协议受限", () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, {
    content: [
      "# 顶层标题",
      "",
      "[本地页](/docs/index.html) [外链](https://example.com) [危险](javascript:alert(1))",
      "",
      "![危险图](javascript:alert(2))",
      "",
      "<script>window.__xss = 1</script>",
      "",
      "```html",
      "<img src=x onerror=alert(1)>",
      "```",
    ].join("\n"),
  }));

  assert.ok(!html.includes("<h1"), "预览正文不能产出 h1，对话框标题已占最高级");
  assert.match(html, /<h2[^>]*>顶层标题<\/h2>/);
  assert.ok(!/<script/i.test(html), "原始 HTML 只能是文本");
  assert.ok(!html.includes("javascript:"), "危险协议不能进入 href/src");
  assert.ok(!/<img/i.test(html), "围栏代码里的 HTML 只能是转义文本，不能变成元素");
  assert.match(html, /<pre data-language="html">/, "围栏语言标签保留");
  assert.match(html, /href="\/api\/local-file\/[A-Za-z0-9_-]+\/"/, "服务端 HTML 路径走本地预览代理");
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /&lt;script&gt;window\.__xss = 1&lt;\/script&gt;/);
});

test("查看器不再手写通用控件，只保留有契约约束的专业面", () => {
  const explorer = sourceOf("src/web-ui/react/file-explorer/host.tsx");
  assert.ok(!explorer.includes("<button"), "文件树控件全部走 WandButton/WandIconButton");
  assert.ok(!explorer.includes("<input"), "重命名与新建输入走 WandInput");
  assert.match(explorer, /<Segmented/);
  assert.match(explorer, /<Progress/);
  assert.match(explorer, /<Spin/);

  const codeEditor = sourceOf("src/web-ui/react/code-editor/host.tsx");
  assert.ok(!codeEditor.includes("<button"), "编辑器工具栏/查找栏/标签关闭都走库按钮");
  assert.ok(!codeEditor.includes("<input"), "查找框走 WandInput");
  // The transparent textarea under the syntax layer is the editor itself, not a control.
  assert.match(codeEditor, /className="resize-none wand-code-editor-textarea"/);

  const filePreview = sourceOf("src/web-ui/react/file-preview/host.tsx");
  assert.match(filePreview, /<Button className="wand-file-preview-download"/);
  assert.match(filePreview, /<Spin /);
  assert.ok(!filePreview.includes("<button"), "缩放台也使用 Ant Button，绘制和原尺寸状态单独保留");
  assert.match(filePreview, /<Image preview=\{false\}/);
  assert.match(filePreview, /<Input.TextArea/);
  assert.match(filePreview, /className=\{`wand-media-stage/);
  assert.ok(filePreview.includes("wand-file-preview-editor"), "源码编辑框仍是专业面");

  const restart = sourceOf("src/web-ui/react/restart-overlay/host.tsx");
  assert.match(restart, /<Spin size="large"/);
  assert.match(restart, /<Progress/);
  assert.match(restart, /showClose=\{false\}/);
  assert.ok(restart.includes("data-wand-autofocus"), "live 文本仍是弹层内唯一的初始焦点");

  const localPreview = sourceOf("src/web-ui/react/local-preview/host.tsx");
  assert.match(localPreview, /<Segmented/);
  assert.match(localPreview, /<WandInput/);
  assert.ok(!localPreview.includes("<input"));
});

test("退役的控件视觉覆盖已删除，没有别处再引用", () => {
  // Every entry: the retired override, the file it left, and the library component
  // that now owns that visual. Retiring an override requires the replacement to be
  // recorded, so a later reviewer can check the appearance without the old rules.
  const retired: ReadonlyArray<[file: string, gone: string, replacement: string]> = [
    ["src/web-ui/react/file-explorer/styles.ts", "@keyframes wand-explorer-dot", "Ant Spin"],
    ["src/web-ui/react/file-explorer/styles.ts", "wand-explorer-progress", "Ant Progress"],
    ["src/web-ui/react/file-explorer/styles.ts", ".wand-explorer-context-divider", "WandMenuSeparator"],
    ["src/web-ui/react/file-explorer/styles.ts", ".wand-explorer-context-item {", "WandMenuItem"],
    ["src/web-ui/react/file-explorer/styles.ts", ".wand-explorer-rename input", "WandInput"],
    ["src/web-ui/react/file-explorer/styles.ts", ".wand-file-explorer-btn:hover", "WandIconButton"],
    ["src/web-ui/react/file-explorer/styles.ts", ".wand-explorer-filter:hover", "Ant Segmented"],
    ["src/web-ui/react/file-explorer/styles.ts", "box-shadow: 0 8px 24px", "theme shadow token"],
    ["src/web-ui/react/code-editor/styles.ts", ".wand-code-editor-toolbar button", "WandButton"],
    ["src/web-ui/react/code-editor/styles.ts", ".wand-code-editor-find-btn", "WandIconButton"],
    ["src/web-ui/react/code-editor/styles.ts", ".wand-code-editor-tab-close", "WandIconButton"],
    ["src/web-ui/react/code-editor/styles.ts", ".wand-code-editor-find-input:focus", "WandInput"],
    ["src/web-ui/react/code-editor/styles.ts", "wand-code-editor-dirty-mark {", "WandBadge"],
    ["src/web-ui/react/file-preview/styles.ts", ".wand-file-preview-download {", "Ant Button link"],
    ["src/web-ui/react/file-preview/styles.ts", ".wand-file-preview-error > span", "WandIcon"],
    ["src/web-ui/react/file-preview/styles.ts", ".wand-file-preview-kind {", "WandBadge"],
    ["src/web-ui/react/file-preview/styles.ts", "cursor: zoom-in", "shared .wand-media-stage"],
    ["src/web-ui/react/local-preview/styles.ts", ".wand-local-preview-mode {", "Ant Segmented"],
    ["src/web-ui/react/local-preview/styles.ts", ".wand-local-preview-field input", "WandInput"],
  ];
  for (const [file, gone, replacement] of retired) {
    assert.ok(
      !sourceOf(file).includes(gone),
      `${file} 不应再保留 ${gone}（现由 ${replacement} 承担）`,
    );
  }
});

test("查看器普通chrome由库组件接管，不保留class外观覆盖", () => {
  const explorer = sourceOf("src/web-ui/react/file-explorer/styles.ts");
  assert.equal(existsSync(new URL("../src/web-ui/react/restart-overlay/styles.ts", import.meta.url)), false, "重启普通chrome迁移后整份旧样式模块删除");
  const preview = sourceOf("src/web-ui/react/file-preview/styles.ts");
  const editor = sourceOf("src/web-ui/react/code-editor/styles.ts");
  for (const [sheet, gone] of [[explorer, ".wand-explorer-row"], [explorer, ".wand-explorer-context-menu"],
    [preview, ".wand-file-preview-toolbar"], [preview, ".wand-file-preview-binary"],
    [editor, ".wand-code-editor-tab {"], [editor, ".wand-code-editor-find {"]]) assert.ok(!sheet.includes(gone), gone);
  assert.match(sourceOf("src/web-ui/react/code-editor/host.tsx"), /<Tabs/);
  assert.match(sourceOf("src/web-ui/react/file-preview/host.tsx"), /<Descriptions/);
  assert.match(sourceOf("src/web-ui/react/file-explorer/host.tsx"), /<Card/);
});

test("可缩放的图片台只定义一次，文件预览复用同一份", () => {
  const checkerboard = "linear-gradient(45deg, var(--bg-tertiary) 25%, transparent 25%)";
  const definers = ["src/web-ui/react/image-viewer/styles.ts", "src/web-ui/react/file-preview/styles.ts"]
    .filter((file) => sourceOf(file).includes(checkerboard));
  assert.deepEqual(definers, ["src/web-ui/react/image-viewer/styles.ts"], "棋盘格只应有一处定义");
  assert.match(sourceOf("src/web-ui/react/image-viewer/styles.ts"), /\.wand-media-stage\.ant-btn \{/);
  assert.match(sourceOf("src/web-ui/react/file-preview/host.tsx"), /wand-media-stage/);
  assert.match(sourceOf("src/web-ui/react/image-viewer/host.tsx"), /wand-media-stage/);
});

test("共享样式表没有接管任何被迁移的查看器控件", () => {
  for (const file of SHARED_SHEETS) {
    const source = sourceOf(file);
    for (const gone of [
      ".wand-explorer-filter",
      ".wand-explorer-context",
      ".wand-code-editor-find-btn",
      ".wand-restart-spinner",
      ".wand-media-stage",
    ]) {
      assert.ok(!source.includes(gone), `${file} 不应接管 ${gone}`);
    }
  }
});

test("解析器与渲染器都没有第二套 HTML/正则实现", () => {
  const model = sourceOf("src/web-ui/react/file-preview/model.ts");
  assert.match(model, /from "marked"/);
  assert.ok(!/INLINE_MARKDOWN|startsMarkdownBlock|splitMarkdownRow/.test(model), "手写块/内联扫描器必须删除");
  for (const file of ["src/web-ui/react/file-preview/host.tsx", "src/web-ui/react/file-preview/markdown.tsx"]) {
    const source = sourceOf(file);
    assert.ok(!source.includes("dangerouslySetInnerHTML"), `${file} must not set inner HTML`);
    assert.ok(!source.includes("innerHTML ="), `${file} must not set inner HTML`);
  }
});
