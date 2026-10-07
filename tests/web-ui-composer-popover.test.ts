import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerPopoverController,
  type ComposerPopoverMount,
  type ComposerPopoverState,
} from "../src/web-ui/react/composer-popover/controller.ts";
import { ComposerPopoverItems } from "../src/web-ui/react/composer-popover/host.tsx";

const STATE: ComposerPopoverState = {
  interactiveVisible: true,
  interactiveOn: false,
};

/** 必须复用同一个 target 对象：controller 用引用比较，重建会让幂等断言误报。 */
const TARGET = {} as HTMLElement;

function mountFor(overrides: Partial<ComposerPopoverMount> = {}): ComposerPopoverMount {
  return {
    key: "composer-popover-items",
    target: TARGET,
    ...STATE,
    onAttach() {},
    onToggleInteractive() {},
    ...overrides,
  };
}

function render(mount: ComposerPopoverMount): string {
  return renderToStaticMarkup(React.createElement(ComposerPopoverItems, { mount }));
}

test("条目渲染出两个按钮，关闭态为「关」且不带 is-on", () => {
  const html = render(mountFor());
  assert.match(html, /id="plus-attach-item"/);
  assert.match(html, /上传附件/);
  assert.match(html, /plus-popover-icon/);
  assert.match(html, /id="terminal-interactive-toggle-top"/);
  assert.match(html, /终端交互/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /plus-popover-toggle-state">关</);
  assert.doesNotMatch(html, /is-on/);
  assert.doesNotMatch(html, / hidden/);
});

test("开启态带 is-on、aria-pressed=true 与「开」文案", () => {
  const html = render(mountFor({ interactiveOn: true }));
  assert.match(html, /class="[^"]*ant-btn[^\"]*\bis-on\b/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /plus-popover-toggle-state">开</);
});

test("开关不可见时用 .hidden 表达，而不是删掉节点", () => {
  const html = render(mountFor({ interactiveVisible: false }));
  assert.match(html, /class="[^"]*ant-btn[^\"]*\bhidden\b/);
  assert.match(html, /id="terminal-interactive-toggle-top"/);
});

test("两个条目都保留 id 与 aria-pressed", () => {
  assert.match(render(mountFor()), /id="terminal-interactive-toggle-top"/);
  assert.match(render(mountFor({ interactiveOn: true })), /aria-pressed="true"/);
});

test("portal 宿主用 display:contents，两个按钮仍是 popover 的 flex item", () => {
  const styles = readFileSync(
    new URL("../src/web-ui/content/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.plus-popover-items-host[^{}]*\{ display: contents; \}/);
  assert.match(styles, /\.composer-plus-popover \[data-composer-popover-host\] \{ display: grid;/);
});
