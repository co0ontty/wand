import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SidebarPeek } from "../src/web-ui/react/shell/sidebar-peek.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function renderPeek(open: boolean): string {
  const children: ReactElement = createElement("span", null, "TREE-MARKER");
  return renderToStaticMarkup(createElement(
    SidebarPeek,
    {
      open,
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
  assert.match(html, /aria-label="任务目录"/);
  assert.match(html, />任务目录</);
  assert.match(html, /aria-label="展开成完整侧栏"/);
  assert.match(html, /TREE-MARKER/);
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
  assert.match(source, /useSidebarPeek\(narrow && hoverPointer, drawerRef, peekSurfaceRef\)/);
  assert.match(source, /narrow && hoverPointer && peek\.mounted/);
  assert.match(source, /\.\.\.peek\.triggerBindings/);
  assert.match(source, /\.\.\.peek\.surfaceBindings/);
  // 同一份树渲染两处：窄栏里 compact，弹出面板里是完整层级，且不带 legacy id。
  assert.match(source, /<div className="sessions-list" id="sessions-list">\s*\{taskTree\(narrow\)\}/);
  assert.match(source, /<div className="sessions-list">\{taskTree\(false\)\}<\/div>/);
});

test("hover hook only opens while the rail is collapsed", () => {
  const source = readFileSync(
    path.join(root, "src", "web-ui", "react", "shell", "use-sidebar-peek.ts"),
    "utf8",
  );

  // 折叠按钮本身就在侧栏里：不过 enabled 的话，点一下收起就会顺手点亮面板。
  assert.match(source, /const requestOpen = React\.useCallback\(\(delay: number\): void => \{\s*if \(!enabled\) return;/);
  // pointerover 而不是 pointerenter：Esc 收起后指针还在窄栏里晃动就该弹回来。
  assert.match(source, /triggerBindings: \{\s*\/\/[^\n]*\n\s*onPointerOver: \(event\) => \{\s*if \(insideSurface\(event\.target\)\) return;\s*requestOpen\(OPEN_DELAY_MS\);/);
  assert.doesNotMatch(source, /onPointerEnter: \(\) => scheduleOpen/);
  // 端口浮层（行内下拉 / 弹窗）自己处理 Esc 和内部点击，面板要让位。
  assert.match(source, /if \(insideFloatingLayer\(event\.target\)\) return;/);
  assert.match(source, /if \(insideFloatingLayer\(target\)\) return;/);
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
