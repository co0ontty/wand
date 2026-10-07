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

test("语音气泡投影状态与转写，保留取消反馈和 live region", () => {
  const idle = render(mountFor());
  assert.match(idle, /id="voice-transcript-bubble" aria-live="polite"/);
  assert.match(idle, /ant-bubble/);
  assert.match(idle, /正在聆听…上滑取消/);
  assert.doesNotMatch(idle, /tabindex|autofocus/i);
  const withText = render(mountFor({ transcript: "转写文字" }));
  assert.match(withText, /转写文字/);
  assert.match(withText, /正在聆听…上滑取消/);
  const canceling = render(mountFor({ canceling: true, transcript: "x", status: "松开手指 取消" }));
  assert.match(canceling, /松开手指 取消/);
  assert.match(canceling, /ant-bubble/);
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
  assert.match(css, /\.composer-voice-host[^{}]*\{ display: contents; \}/);
});
