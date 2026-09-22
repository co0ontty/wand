import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  codexActivityRe,
  codexFooterRe,
  isPtyCodexNoiseLine,
  isPtyNoiseLine,
  isPtySystemInfoNoiseLine,
  isPtyTranscriptNoiseLine,
} from "../src/web-ui/browser/pty-noise.ts";

test("聊天流噪声行覆盖各 provider 的界面文案", () => {
  for (const line of [
    "────",
    "├────┤",
    "❯",
    "›",
    "▁▂▃▄",
    "esc to interrupt",
    "Claude Code v2.0.1",
    "Sonnet 4.5 with 200k context",
    "? for shortcuts",
    "/effort high",
    "OpenAI Codex",
    "model: gpt-5.1",
    "thinking...",
    "• Working",
    "ctrl+o",
    "cwd: /Users/me",
  ]) {
    assert.equal(isPtyNoiseLine(line), true, `应当判为噪声: ${line}`);
  }
  for (const line of ["修复登录按钮的样式", "# 注释行", "- 列表项", "请看这段 diff"]) {
    assert.equal(isPtyNoiseLine(line), false, `不得吞掉内容行: ${line}`);
  }
  assert.equal(isPtyNoiseLine(""), false);
  assert.equal(isPtyNoiseLine(null), false);
  // 已知局限（与改动前一致）：字符集里没有 ╮/╰，所以 ╭───╮ 这类 banner 框线在聊天流里保留。
  assert.equal(isPtyNoiseLine("╭────────────╮"), false);
});

test("system-info 卡片过滤比聊天流窄：banner 与 provider 行要留给卡片", () => {
  for (const line of ["────", "❯", "?", "Claude Code v2.0.1", "Opus 4 with 200k", "Sonnet 4 with 1m", "API Usage 12%", "Billing", "for shortcuts", "/effort low", "▸▸▸"]) {
    assert.equal(isPtySystemInfoNoiseLine(line), true, `卡片应过滤: ${line}`);
  }
  // 与聊天流的差异（有意保留）：卡片要展示 banner 框线、provider 名与 model 行。
  for (const line of ["╭────────────╮", "OpenAI Codex", "model: gpt-5.1", "│ ✻ Welcome │"]) {
    assert.equal(isPtySystemInfoNoiseLine(line), false, `卡片应保留: ${line}`);
  }
  assert.equal(isPtySystemInfoNoiseLine(""), false);
});

test("PTY 转写抓取另有更宽的一套（npm 日志、TUI 碎片）", () => {
  for (const line of [
    "Claude Code v2.0.1",
    "npm WARN deprecated foo",
    "npm notice created a lockfile",
    "added 42 packages in 3s",
    "audited 42 packages in 1s",
    "✻F",
    "● high",
    "~/repo",
    "Fluttering…",
    "shift+tab",
  ]) {
    assert.equal(isPtyTranscriptNoiseLine(line), true, `转写应丢弃: ${line}`);
  }
  for (const line of ["修复登录 bug", "const a = 1;", "请看这段 diff"]) {
    assert.equal(isPtyTranscriptNoiseLine(line), false, `转写应保留: ${line}`);
  }
  assert.equal(isPtyTranscriptNoiseLine(""), true);
});

test("Codex 判定是聊天流噪声的超集", () => {
  for (const line of [
    "",
    "   ",
    "›",
    "OpenAI Codex",
    "model: gpt-5",
    "Thinking...",
    "• Running tests",
    "Claude Code v2.0.1",
    "MMM",
    "gpt-5.1 codex · 42% left · /Users/me/repo",
  ]) {
    assert.equal(isPtyCodexNoiseLine(line), true, `Codex 应忽略: ${JSON.stringify(line)}`);
  }
  for (const line of ["修复登录 bug", "const a = 1;"]) {
    assert.equal(isPtyCodexNoiseLine(line), false, `Codex 应保留: ${line}`);
  }
  assert.equal(codexFooterRe.test("gpt-5.1 codex · 42% left · /Users/me/repo"), true);
  assert.equal(codexActivityRe.test("Completed the refactor"), true);
});

test("噪声文案只在 pty-noise.ts 维护，chat-render 不再自带过滤列表", () => {
  const renderSource = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8");
  assert.doesNotMatch(renderSource, /function isNoiseLine/, "聊天流噪声列表必须来自 pty-noise");
  assert.doesNotMatch(renderSource, /shouldIgnoreCodexLine/, "Codex 判定必须来自 pty-noise");
  assert.doesNotMatch(renderSource, /\/\/ Filter noise/, "转写抓取不得再内联一套文案列表");
  assert.doesNotMatch(renderSource, /Claude Code v/, "CLI 文案不得留在渲染层");
  assert.match(renderSource, /from "\.\/pty-noise"/);
});
