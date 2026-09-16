import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerActionErrorController,
  type ComposerActionErrorMount,
} from "../src/web-ui/react/composer-action-error/controller.ts";
import { ComposerActionError } from "../src/web-ui/react/composer-action-error/host.tsx";

const TARGET = {} as HTMLElement;

function mountFor(message: string, overrides: Partial<ComposerActionErrorMount> = {}): ComposerActionErrorMount {
  return { key: "action-error", target: TARGET, message, ...overrides };
}

test("错误条注册表在文案未变时跳过广播", () => {
  const controller = new ComposerActionErrorController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([mountFor("无法删除会话。")]);
  assert.equal(notifications, 1);
  const first = controller.getSnapshot();

  // render() 与 showActionError() 都会同步一遍，值没变不能重复广播。
  controller.sync([mountFor("无法删除会话。")]);
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot(), first);

  controller.sync([mountFor("无法清理该目录的历史会话。")]);
  assert.equal(notifications, 2);
  assert.equal(controller.getSnapshot().revision, 2);

  // 没有错误时适配器传空 mounts（而不是渲染一条空文案）。
  controller.clear();
  assert.equal(notifications, 3);
  assert.equal(controller.getSnapshot().mounts.length, 0);
  unsubscribe();
});

test("错误条保留 #action-error 与 .error-message 选择器", () => {
  const html = renderToStaticMarkup(
    React.createElement(ComposerActionError, { mount: mountFor("密码错误，请重试。") }),
  );
  assert.match(html, /<p id="action-error" class="error-message">/);
  assert.match(html, /密码错误，请重试。/);
  // 旧节点用 .hidden 表达隐藏；现在隐藏等于不渲染。
  assert.doesNotMatch(html, /hidden/);
});

test("适配器只在有文案时发布 mount，并用 flushSync 立刻可见", () => {
  const source = readFileSync(
    new URL("../src/web-ui/browser/composer-action-error.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!message\) return null;/);
  assert.match(source, /flush: true/);
  assert.match(source, /data-composer-action-error-host/);
  // 文案存在 state 里，不再有人 getElementById("action-error") 写 DOM。
  assert.match(source, /state\.actionError = message/);
});

test("没有调用方再直接写 #action-error 节点", () => {
  for (const file of [
    "../src/web-ui/browser/input.ts",
    "../src/web-ui/browser/sidebar.ts",
    "../src/web-ui/browser/session-engine.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /getElementById\(["']action-error["']\)/, file);
  }
});

test("resumeSession 不再接收从不传入的 errorEl 参数", () => {
  const source = readFileSync(
    new URL("../src/web-ui/browser/input.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /function resumeSession\(sessionId\) \{/);
  assert.match(source, /function ensureSessionReadyForInput\(session\) \{/);
  assert.doesNotMatch(source, /errorEl/);
});
