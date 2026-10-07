import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerConfigController,
  type ComposerConfigMount,
  type ComposerConfigState,
} from "../src/web-ui/react/composer-config/controller.ts";
import { ComposerConfigControl } from "../src/web-ui/react/composer-config/host.tsx";

const STATE: ComposerConfigState = {
  groupTitle: "模式 默认 · 模型 Sonnet · 思考 中",
  modeLabel: "默认",
  modelFullLabel: "claude-sonnet-4-5",
  modelRefreshing: false,
  thinkingValue: "standard",
  thinkingLabel: "中",
};

const TARGET = {} as HTMLElement;

function mountFor(
  scope: ComposerConfigMount["scope"],
  overrides: Partial<ComposerConfigMount> = {},
): ComposerConfigMount {
  return {
    key: `composer-config-${scope}`,
    target: TARGET,
    scope,
    ...STATE,
    onRefreshModels() {},
    ...overrides,
  };
}

function render(mount: ComposerConfigMount): string {
  return renderToStaticMarkup(React.createElement(ComposerConfigControl, { mount }));
}

test("mode 作用域只渲染模式 chip", () => {
  const html = render(mountFor("mode"));
  assert.match(html, /data-composer-config-host-none|composer-config-controls-mode/);
  assert.match(html, /data-config-scope="mode"/);
  assert.match(html, /aria-label="权限模式"/);
  assert.match(html, /data-mode-control-pill="mode"/);
  assert.doesNotMatch(html, /data-mode-control-pill="model"/);
  assert.doesNotMatch(html, /data-mode-control-pill="thinking"/);
  assert.doesNotMatch(html, /data-models-refresh/);
});

test("runtime 作用域渲染模型与思考，含刷新按钮", () => {
  const html = render(mountFor("runtime"));
  assert.match(html, /aria-label="模型与思考设置"/);
  assert.doesNotMatch(html, /data-mode-control-pill="mode"/);
  assert.match(html, /data-mode-control-pill="model"/);
  assert.match(html, /data-mode-control-pill="thinking"/);
  assert.match(html, /data-models-refresh=""/);
  assert.match(html, /data-models-refresh-scope="runtime"/);
});

test("all 作用域渲染三件套", () => {
  const full = render(mountFor("all"));
  assert.match(full, /aria-label="会话设置"/);
  assert.match(full, /data-mode-control-pill="mode"/);
  assert.match(full, /data-mode-control-pill="model"/);
  assert.match(full, /data-mode-control-pill="thinking"/);
  assert.match(full, /data-models-refresh-scope="all"/);
});

test("chip 暴露完整值给 tooltip，并用 data-thinking 记录归一化后的深度", () => {
  const html = render(mountFor("all"));
  assert.match(html, /title="模式 默认 · 模型 Sonnet · 思考 中"/);
  assert.match(html, /title="模式：默认"/);
  assert.match(html, /title="模型：claude-sonnet-4-5"/);
  assert.match(html, /title="思考深度：中"/);
  assert.match(html, /data-thinking="standard"/);
});

test("刷新中的模型按钮进入 busy 态", () => {
  const html = render(mountFor("runtime", { modelRefreshing: true }));
  assert.match(html, /ant-btn/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled/);
  assert.match(html, /title="正在刷新模型列表"/);
});

test("select 宿主带 scope/control/key，供 composer-select 适配器扫描", () => {
  const html = render(mountFor("all"));
  assert.match(
    html,
    /data-composer-select-host="" data-composer-select-key="all-mode" data-composer-select-scope="all" data-mode-control="mode"/,
  );
  assert.equal((html.match(/data-composer-select-host=""/g) || []).length, 3);
});

test("portal 宿主用 display:contents，chip 仍是状态行的 flex item", () => {
  const styles = readFileSync(
    new URL("../src/web-ui/content/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.composer-config-host[^{}]*\{ display: contents; \}/);
  assert.match(styles, /\.composer-status-row[^{}]*\{ display: flex; align-items: center;/);
});
