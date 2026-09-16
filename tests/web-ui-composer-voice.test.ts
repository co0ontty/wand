import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerVoiceController,
  type ComposerVoiceMount,
} from "../src/web-ui/react/composer-voice/controller.ts";
import { ComposerVoiceBubble } from "../src/web-ui/react/composer-voice/host.tsx";

const TARGET = {} as HTMLElement;

function mountFor(overrides: Partial<ComposerVoiceMount> = {}): ComposerVoiceMount {
  return {
    key: "composer-voice",
    target: TARGET,
    canceling: false,
    transcript: "",
    status: "正在聆听…上滑取消",
    ...overrides,
  };
}

function render(mount: ComposerVoiceMount): string {
  return renderToStaticMarkup(React.createElement(ComposerVoiceBubble, { mount }));
}

test("语音气泡注册表只在值变化时广播", () => {
  const controller = new ComposerVoiceController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([mountFor()]);
  assert.equal(notifications, 1);
  const first = controller.getSnapshot();

  // handleVoiceMove 同一次滑动里可能重复喊；值没变不能重播 voice-bubble-in 动画。
  controller.sync([mountFor()]);
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot(), first);

  controller.sync([mountFor({ canceling: true, status: "松开手指 取消" })]);
  assert.equal(notifications, 2);

  controller.sync([mountFor({ transcript: "你好" })]);
  assert.equal(notifications, 3);

  // 非录音态：适配器传空 mounts。
  controller.clear();
  assert.equal(notifications, 4);
  assert.equal(controller.getSnapshot().mounts.length, 0);
  unsubscribe();
});

test(".has-text 与 .is-canceling 由状态推导，保留原 class 与结构", () => {
  const idle = render(mountFor());
  assert.match(idle, /<div id="voice-transcript-bubble" class="voice-transcript-bubble" aria-live="polite">/);
  assert.doesNotMatch(idle, /has-text|is-canceling/);
  // 非录音态不再靠 .hidden（改为不渲染），但波浪与箭头装饰必须留着。
  assert.doesNotMatch(idle, /class="[^"]*hidden/);
  assert.match(idle, /<span class="voice-wave" aria-hidden="true"><i><\/i><i><\/i><i><\/i><i><\/i><\/span>/);
  assert.match(idle, /<span class="voice-bubble-arrow" aria-hidden="true"><\/span>/);
  assert.match(idle, /<span class="voice-transcript-status">正在聆听…上滑取消<\/span>/);

  const withText = render(mountFor({ transcript: "转写文字" }));
  assert.match(withText, /class="voice-transcript-bubble has-text"/);
  assert.match(withText, /<div class="voice-transcript-text">转写文字<\/div>/);

  const canceling = render(mountFor({ canceling: true, transcript: "x", status: "松开手指 取消" }));
  assert.match(canceling, /class="voice-transcript-bubble is-canceling has-text"/);
  assert.match(canceling, /松开手指 取消/);
});

test("legacy 侧不再读写气泡三个节点", () => {
  const source = readFileSync(
    new URL("../src/web-ui/browser/input.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /getElementById\("voice-transcript-bubble"\)/);
  assert.doesNotMatch(source, /getElementById\("voice-transcript-text"\)/);
  assert.doesNotMatch(source, /getElementById\("voice-transcript-status"\)/);
  // STT 注入点保留：接入真实识别后只调它。
  assert.match(source, /export function updateVoiceTranscript\(text\) \{/);
  assert.match(source, /voiceState\.bubbleVisible = true;/);
  assert.match(source, /syncVoiceBubble\(\);/);
});

test("迁移后 .voice-transcript-bubble.hidden 已成死规则", () => {
  const css = readFileSync(
    new URL("../src/web-ui/content/styles.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(css, /\.voice-transcript-bubble\.hidden/);
  assert.match(css, /\.composer-voice-host \{ display: contents; \}/);
});
