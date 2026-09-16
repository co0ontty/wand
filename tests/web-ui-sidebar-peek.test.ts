import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarPeek } from "../src/web-ui/react/shell/sidebar-peek.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function renderPeek(open: boolean, top = 8): string {
  const children: ReactElement = createElement("span", null, "TREE-MARKER");
  return renderToStaticMarkup(createElement(
    SidebarPeek,
    {
      open,
      title: "Wand 项目",
      top,
      surfaceRef: { current: null },
      onExpand: () => {},
      onPointerEnter: () => {},
      onPointerLeave: () => {},
      onFocusCapture: () => {},
      onBlurCapture: () => {},
    },
    children,
  ));
}

test("SidebarPeek stays hidden and inert until the pointer arrives", () => {
  const html = renderPeek(false);

  assert.match(html, /id="sidebar-peek" class="sidebar-peek"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /inert=""/);
  assert.doesNotMatch(html, /class="sidebar-peek open"/);
  // 面板常挂载：内容（目录树）跟着一起渲染，只是被 CSS 藏起来。
  assert.match(html, /TREE-MARKER/);
});

test("SidebarPeek exposes the directory tree and an expand escape hatch", () => {
  const html = renderPeek(true);

  assert.match(html, /class="sidebar-peek open"/);
  assert.match(html, /data-open="true"/);
  assert.doesNotMatch(html, /inert=/);
  assert.match(html, /aria-label="Wand 项目"/);
  assert.match(html, />Wand 项目</);
  assert.doesNotMatch(html, />任务目录</);
  assert.match(html, /aria-label="展开成完整侧栏"/);
  assert.match(html, /TREE-MARKER/);
});

test("SidebarPeek follows its directory trigger and stays within the viewport", () => {
  const html = renderPeek(true, 180);
  assert.match(html, /top:180px/);
  assert.match(html, /max-height:calc\(100dvh - 192px\)/);
});

test("SidebarPeek never duplicates the legacy sidebar ids", () => {
  for (const open of [false, true]) {
    const html = renderPeek(open);
    assert.doesNotMatch(html, /id="sessions-panel"/);
    assert.doesNotMatch(html, /id="sessions-list"/);
  }
});

test("ShellSidebar drives the peek from hover/focus on the collapsed rail", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "shell-sidebar.tsx"),
    "utf8",
  );

  // 展开后的完整侧栏不再挂第二份目录树：启用条件绑定在窄栏上。
  assert.match(source, /useSidebarPeek\(narrow && hoverPointer && !moreOpen, drawerRef, peekSurfaceRef, selectPeekDirectory\)/);
  assert.match(source, /narrow && hoverPointer && peek\.mounted/);
  assert.match(source, /\.\.\.peek\.triggerBindings/);
  assert.match(source, /\.\.\.peek\.surfaceBindings/);
  // 窄栏按目录显示图标，悬浮树只传当前目录，不复制 legacy id。
  assert.match(source, /<div className="sessions-list" id="sessions-list">\s*\{taskTree\(narrow\)\}/);
  assert.match(source, /<div className="sessions-list">\{taskTree\(false, peekDirectory.id\)\}<\/div>/);
});

test("hover hook only opens while the rail is collapsed", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "use-sidebar-peek.ts"),
    "utf8",
  );

  // 折叠按钮本身就在侧栏里：不过 enabled 的话，点一下收起就会顺手点亮面板。
  assert.match(source, /const requestOpen = React\.useCallback\(\(delay: number\): void => \{\s*if \(!enabled\) return;/);
  // 只允许带目录标识的图标触发预览，面板自身不重复触发。
  assert.match(source, /if \(!enabled \|\| insideSurface\(target\) \|\| insideFloatingLayer\(target\)\) return;/);
  assert.match(source, /target.closest<HTMLElement>\("\[data-sidebar-directory-id\]"\)/);
  assert.match(source, /onDirectory\(id, trigger\);\s*requestOpen\(delay\);/);
  assert.doesNotMatch(source, /onPointerEnter: \(\) => scheduleOpen/);
  // 端口浮层（行内下拉 / 弹窗）自己处理 Esc 和内部点击，面板要让位。
  assert.match(source, /if \(insideFloatingLayer\(event\.target\)\) return;/);
  assert.match(source, /if \(insideFloatingLayer\(target\)\) return;/);
  // Esc 只在焦点真在侧栏（窄栏或面板）里时才接管：
  // 焦点在终端 / 聊天框时 Esc 属于它们（xterm 会把 Esc 发给 CLI）。
  assert.match(source, /const focused = document\.activeElement;\s*if \(!holds\(focused\)\) return;/);
  assert.match(source, /if \(focused instanceof HTMLElement && surfaceRef\.current\?\.contains\(focused\)\) \{\s*focused\.blur\(\);/);
});

test("SidebarPeek styles anchor the panel to the rail's right edge", () => {
  const css = readFileSync(path.join(root, "src", "web-ui", "content", "styles.css"), "utf8");
  const block = css.slice(css.indexOf(".sidebar-peek {"), css.indexOf(".sidebar-peek-header"));

  assert.ok(block.length > 0, "缺少 .sidebar-peek 样式块");
  assert.match(block, /position: fixed;/);
  assert.match(block, /left: 100%;/);
  assert.match(block, /visibility: hidden;/);
  assert.match(block, /pointer-events: none;/);
  assert.match(css, /\.sidebar-peek\.open \{[\s\S]*?visibility: visible;[\s\S]*?pointer-events: auto;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar-peek \{\s*transition: none;/);
});
