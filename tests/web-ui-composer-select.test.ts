import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerSelectController,
  type ComposerSelectMount,
} from "../src/web-ui/react/composer-select/controller.ts";
import { filterSelectOptions, WandSelect } from "../src/web-ui/react/ui/select.tsx";
import {
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

test("composer config markup delegates selection to the React WandSelect host", () => {
  const sessionEngine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  const start = sessionEngine.indexOf("export function renderComposerConfigControlsHtml");
  const end = sessionEngine.indexOf("export function refreshAllChatModeTrios", start);
  const renderBlock = sessionEngine.slice(start, end);
  const host = readFileSync(
    new URL("../src/web-ui/react/composer-select/host.tsx", import.meta.url),
    "utf8",
  );

  assert.match(sessionEngine, /data-composer-select-host/);
  assert.match(renderBlock, /renderComposerSelectHost/);
  assert.match(renderBlock, /showModelRefresh = scope === "runtime" \|\| showExtended/);
  assert.match(renderBlock, /data-models-refresh-scope/);
  assert.doesNotMatch(renderBlock, /<select/);
  assert.match(host, /<WandSelect/);
  assert.match(host, /searchable=\{mount.control === "model"\}/);
  assert.match(host, /searchPlaceholder="搜索模型"/);
});
