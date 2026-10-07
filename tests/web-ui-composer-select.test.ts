import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OPENROUTER_FREE_GROUP, OPENROUTER_FREE_SELECTOR } from "../src/openrouter-free-selection.js";
import {
  ComposerSelectController,
  type ComposerSelectMount,
} from "../src/web-ui/react/composer-select/controller.ts";
import { filterSelectOptions, WandSelect } from "../src/web-ui/react/ui/select.tsx";
import {
  modelDisplayName,
  normalizeAvailableComposerValue,
  normalizeComposerModelValue,
} from "../src/web-ui/browser/composer-select-values.ts";

test("composer select controller publishes immutable portal mount snapshots", () => {
  const controller = new ComposerSelectController();
  const target = {} as HTMLElement;
  const mount: ComposerSelectMount = {
    key: "runtime-model",
    target,
    control: "model",
    scope: "runtime",
    value: "sonnet",
    options: [{ value: "sonnet", label: "Sonnet" }],
    ariaLabel: "模型",
    onValueChange() {},
  };
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([mount]);
  const first = controller.getSnapshot();
  assert.equal(first.revision, 1);
  assert.deepEqual(first.mounts, [mount]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.mounts));
  assert.equal(notifications, 1);

  controller.clear();
  assert.equal(controller.getSnapshot().mounts.length, 0);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("WandSelect accepts the composer default-model empty value", () => {
  const html = renderToStaticMarkup(React.createElement(WandSelect, {
    value: "",
    placeholder: "默认",
    ariaLabel: "模型",
    options: [
      { value: "", label: "默认 · 跟随服务端" },
      { value: "sonnet", label: "Sonnet" },
    ],
  }));
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="模型"/);
});

test("filterSelectOptions matches model id and label keywords", () => {
  const options = [
    { value: "", label: "默认 · Claude Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Opus 4.6" },
    { value: "openai/gpt-5.4", label: "GPT-5.4" },
    { value: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
  ];
  assert.deepEqual(filterSelectOptions(options, "  ").map((item) => item.value), options.map((item) => item.value));
  assert.deepEqual(filterSelectOptions(options, "opus").map((item) => item.value), ["claude-opus-4-6"]);
  assert.deepEqual(filterSelectOptions(options, "GPT 5.4").map((item) => item.value), ["openai/gpt-5.4"]);
  assert.deepEqual(filterSelectOptions(options, "默认").map((item) => item.value), [""]);
  assert.equal(filterSelectOptions(options, "kimi xyz").length, 0);
});

test("searchable WandSelect keeps the composer trigger contract", () => {
  const html = renderToStaticMarkup(React.createElement(WandSelect, {
    value: "",
    placeholder: "默认",
    ariaLabel: "模型",
    searchable: true,
    searchPlaceholder: "搜索模型",
    options: [
      { value: "", label: "默认 · 跟随服务端" },
      { value: "sonnet", label: "Sonnet" },
    ],
  }));
  assert.match(html, /role="combobox"|aria-haspopup="listbox"/);
  assert.match(html, /aria-label="模型"/);
});

test("composer select values always resolve to a rendered option", () => {
  assert.equal(normalizeComposerModelValue("default"), "");
  assert.equal(normalizeComposerModelValue("sonnet"), "sonnet");

  const thinkingOptions = [
    { value: "off" },
    { value: "standard" },
  ];
  assert.equal(normalizeAvailableComposerValue("standard", thinkingOptions, "off"), "standard");
  assert.equal(normalizeAvailableComposerValue("max", thinkingOptions, "off"), "off");
});

test("composer 三件套的 chip 与内层 select 宿主都由 React 渲染", () => {
  const sessionEngine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  const render = readFileSync(
    new URL("../src/web-ui/browser/render.ts", import.meta.url),
    "utf8",
  );
  const host = readFileSync(
    new URL("../src/web-ui/react/composer-config/host.tsx", import.meta.url),
    "utf8",
  );
  const adapter = readFileSync(
    new URL("../src/web-ui/browser/composer-config-adapter.ts", import.meta.url),
    "utf8",
  );
  const selectHost = readFileSync(
    new URL("../src/web-ui/react/composer-select/host.tsx", import.meta.url),
    "utf8",
  );

  // 旧渲染器与它吐出的 data-* 钩子必须一起消失，否则会出现两个写入者。
  assert.doesNotMatch(sessionEngine, /renderComposerConfigControlsHtml/);
  assert.doesNotMatch(sessionEngine, /renderComposerSelectHost/);
  assert.doesNotMatch(sessionEngine, /data-models-refresh/);
  assert.doesNotMatch(sessionEngine, /"\.composer-config-controls"/);

  // 宿主常驻在种子 markup 里，切会话后 portal 目标仍然有效。
  assert.match(render, /data-composer-config-host="mode"/);
  assert.match(render, /data-composer-config-host="runtime"/);
  assert.match(render, /data-composer-config-host="all"/);

  // chip 结构 + 选择委托都在 React 侧，且不回到原生 select。
  assert.match(host, /data-mode-control-pill="mode"/);
  assert.match(host, /data-mode-control-pill="model"/);
  assert.match(host, /data-mode-control-pill="thinking"/);
  assert.match(host, /data-composer-select-host=""/);
  assert.match(host, /data-models-refresh=""/);
  assert.match(host, /data-models-refresh-scope=\{scope\}/);
  assert.doesNotMatch(host, /<select/);

  // chip 里会长出 select 宿主，所以配置同步必须同步提交后 select 才能扫到。
  assert.match(adapter, /syncPortalMounts<ComposerConfigMount>\(\{/);
  assert.match(adapter, /flush: true/);
  assert.match(adapter, /data-composer-config-host/);
  assert.match(selectHost, /<WandSelect/);
  assert.match(selectHost, /searchable=\{mount\.control === "model"\}/);
  assert.match(selectHost, /searchPlaceholder="搜索模型"/);
});

test("免费分组在输入栏直接可选，显式、默认和未加载目录时均显示分组名", () => {
  const model = { id: OPENROUTER_FREE_SELECTOR, label: OPENROUTER_FREE_GROUP };
  const markup = renderToStaticMarkup(React.createElement(WandSelect, {
    value: model.id, ariaLabel: "模型", options: [{ value: model.id, label: model.label }],
    onValueChange() {},
  }));
  assert.match(markup, /免费分组/);
  assert.equal(modelDisplayName(model.id, [model], ""), "免费分组");
  assert.equal(modelDisplayName("default", [model], model.id), "免费分组");
  assert.equal(modelDisplayName(model.id, [], ""), "免费分组");
  assert.equal(modelDisplayName("", [], model.id), "免费分组");
});

test("输入栏模型触发器不写「默认模型/默认」：哨兵换成服务端默认模型的名字", () => {
  const models = [
    { id: "default", label: "跟随 Claude Code 默认" },
    { id: "opus", label: "opus（最新 Opus）" },
  ];
  // 服务端配了默认模型：写它的名字（触发器再压缩掉括号补充）。
  assert.equal(modelDisplayName("default", models, "opus"), "opus（最新 Opus）");
  assert.equal(modelDisplayName("", models, "opus"), "opus（最新 Opus）");
  // 没配：用 CLI 自己报出来的默认项名字；只有「跟随 X 默认」这种没名字的文案才留空给调用方兜底。
  assert.equal(modelDisplayName("default", [{ id: "default", label: "grok-4.7（Grok 默认）" }], ""), "grok-4.7");
  // 真实文案「跟随 Claude Code 默认」是多词，别被单字的正则放过去当成模型名。
  assert.equal(modelDisplayName("default", models, ""), "");
  // 显式选的模型原样回它的目录标签。
  assert.equal(modelDisplayName("opus", models, ""), "opus（最新 Opus）");
  assert.equal(modelDisplayName("custom-id", models, ""), "custom-id");
});
