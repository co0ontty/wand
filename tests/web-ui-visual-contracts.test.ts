import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { foundationStyles } from "../src/web-ui/react/styles/base.js";
import {
  MOTION_DWELL_FAILED_MS,
  MOTION_DWELL_RESULT_SENTENCE_MS,
  MOTION_DWELL_SENT_MS,
} from "../src/web-ui/react/ui/motion-tokens.js";

const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `Missing rule: ${selector}`);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

test("login and shared controls use the same flat geometry and primary color", () => {
  assert.match(styles, /--control-radius: 6px/);
  assert.match(rule(".login-page .form-col .btn"), /border-radius: var\(--control-radius\)/);
  assert.match(foundationStyles, /\.wand-ui-button \{\s*border-radius: var\(--control-radius\)/);
  assert.match(rule(".blank-chat-tool-btn.welcome-new-task"), /background: var\(--accent-solid\)/);
  assert.match(rule(".input-composer .btn-circle-send"), /background: var\(--accent-solid\)/);
  assert.match(rule(".input-composer .btn-circle-send"), /box-shadow: none/);
  assert.match(foundationStyles, /\.wand-ui-button-primary::before,[\s\S]*?background: transparent/);
});

test("sidebar colors alias the login palette instead of introducing a second palette", () => {
  for (const [alias, token] of [
    ["surface", "bg-primary"], ["surface-raised", "bg-elevated"],
    ["ink", "text-primary"], ["muted", "text-tertiary"],
    ["line", "border-subtle"], ["hover", "bg-hover"], ["active", "accent-muted"],
  ]) {
    assert.ok(styles.includes(`--web-sidebar-${alias}: var(--${token});`));
  }
});

test("Appica press feedback cannot reintroduce scaling or vertical jumps", () => {
  const press = foundationStyles.slice(foundationStyles.indexOf(".wand-ui-button:is(:active"));
  const block = press.slice(0, press.indexOf("}"));
  assert.match(block, /scale: none/);
  assert.match(block, /translate: none/);
  assert.match(block, /transform: none/);
  assert.match(foundationStyles, /\.wand-ui-button:focus-visible/);
});

test("portalled menus remain interactive above the shell", () => {
  const start = foundationStyles.indexOf(".wand-ui-dropdown-content {");
  const menu = foundationStyles.slice(start, foundationStyles.indexOf("}", start));
  assert.match(menu, /pointer-events: auto/);
  assert.match(menu, /z-index: 10/);
});

test("the task welcome glyph remains visible on the paper surface", () => {
  const icon = rule(".workspace-task-welcome .blank-chat-logo");
  assert.match(icon, /color: var\(--text-secondary\)/);
  assert.match(icon, /background: var\(--bg-secondary\)/);
  assert.doesNotMatch(icon, /color: white/);
});

test("hover actions preserve title width and keyboard access", () => {
  const start = styles.indexOf("/* Reserve the action gutter");
  assert.ok(start >= 0);
  const gutter = styles.slice(start, styles.indexOf("}\n}", start) + 3);
  assert.match(gutter, /:not\(:focus-within\)/);
  assert.match(gutter, /opacity: 0/);
  assert.doesNotMatch(gutter, /(?:min-)?width: 0|margin-left: -/);
});

const DWELL_SOURCES = [
  "react/issues/team-run-panel.tsx",
  "react/quick-commit/host.tsx",
  "react/settings/fields.tsx",
  "react/settings/tabs.tsx",
  "react/workspaces/workspaces-panel.tsx",
  "react/worktree-merge/host.tsx",
  "react/issues/task-board-icons.tsx",
];

test("反馈驻留只从 motion-tokens 取，页面不再写死毫秒", () => {
  for (const rel of DWELL_SOURCES) {
    const source = readFileSync(new URL(`../src/web-ui/${rel}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:650|1100|1400|2800)\b/, `${rel} 残留旧的驻留毫秒字面量`);
    // 单条 `[^;]` 形态扫不到多语句回调（setTimeout(() => { a(); b(); }, 999)：回调体里的分号先截断了匹配）。
    // 所以再补一条：按花括号把回调体整体吃进来，仍要求结尾是字面毫秒实参。
    assert.doesNotMatch(source, /setTimeout\(\s*[^;]*?,\s*\d+\s*\)/, `${rel} 给 setTimeout 传了字面毫秒`);
    // 这条箭头函数版以前只认 `() => {`，`(e) => { … }, 999` 和 `async () => { … }, 999`
    // 都从缝里漏掉。现在放宽到「带参数的箭头 + async 前缀」，回调体仍只吃一层嵌套。
    // 注意：这是文本钉，不是解析器 —— 两层以上嵌套的函数体依旧扫不到，真要靠它兜住
    // 所有形态得换 AST 遍历。它的作用是让「新写一个字面毫秒」在这几种常见形态下报警。
    assert.doesNotMatch(
      source,
      /setTimeout\(\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{(?:[^{}]|\{[^{}]*\})*\}\s*,\s*\d+\s*\)/,
      `${rel} 在多语句回调里给 setTimeout 传了字面毫秒`,
    );
  }
  const tokens = readFileSync(new URL("../src/web-ui/react/ui/motion-tokens.ts", import.meta.url), "utf8");
  assert.match(tokens, /export const MOTION_DWELL_SENT_MS = 720;/);
  assert.match(tokens, /export const MOTION_DWELL_FAILED_MS = 1500;/);
  // 失败停留 ≥ 成功；整句结果介于两者之间。
  assert.ok(MOTION_DWELL_FAILED_MS >= MOTION_DWELL_SENT_MS);
  assert.ok(MOTION_DWELL_RESULT_SENTENCE_MS > MOTION_DWELL_SENT_MS);
  assert.ok(MOTION_DWELL_RESULT_SENTENCE_MS <= MOTION_DWELL_FAILED_MS);
  assert.match(readFileSync(new URL("../src/web-ui/react/issues/task-board-icons.tsx", import.meta.url), "utf8"), /MOTION_PROCESSING_STAGGER_MS/);
});

test("原位已有结果的反馈不再同时弹 Toast", () => {
  const quickCommit = readFileSync(new URL("../src/web-ui/react/quick-commit/host.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(quickCommit, /toast\(/, "快捷提交的成功/失败都已有原位反馈");
  const worktree = readFileSync(new URL("../src/web-ui/react/worktree-merge/host.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(worktree, /toast\(/, "worktree 合并与清理改成弹层体内原位停留");
  const settings = readFileSync(new URL("../src/web-ui/react/settings/tabs.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    settings,
    /toast\("(GitHub 已连接|GitHub 已断开|基本配置已保存|AI 与模型配置已保存|显示设置已保存|密码已修改)/,
    "设置保存结果只留在原位 flash",
  );
  // 改密码后的延后 reload 与整句结果驻留对齐，用户读得完再跳登录页。
  assert.match(
    settings,
    /window\.location\.reload\(\);\s*\}, MOTION_DWELL_RESULT_SENTENCE_MS\)/,
    "改密码的延后 reload 必须等驻留结束",
  );
  const workspaces = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(workspaces, /toast\(result, "info"\)/, "批量管理结果只写在原位置按钮上");
});

// 发送 ⇄ 停止（docs/motion-design.md §3、§4）：一颗按钮的相位模型 + 原位结果行。
// 这里钉的是「结构」而不是手感：单宿主、四层 glyph、相位属性、token 化时长、
// 以及旧的两按钮 / .input-hint / 发送类 Toast 三种形态都不许回来。
test("发送与停止是同一颗按钮的相位模型，结果原位显示不借 Toast", () => {
  const renderSrc = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  const inputSrc = readFileSync(new URL("../src/web-ui/browser/input.ts", import.meta.url), "utf8");
  const engineSrc = readFileSync(new URL("../src/web-ui/browser/session-engine.ts", import.meta.url), "utf8");
  const notificationsSrc = readFileSync(new URL("../src/web-ui/browser/notifications.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");

  // ① 旧模型（两颗按钮 + display:none 互斥）不许以任何形式回来，包括「留个隐藏节点」。
  assert.ok(!renderSrc.includes('id="stop-button"'), "种子里不许有第二个发送/停止节点");
  assert.ok(!inputSrc.includes('"stop-button"'), "legacy 不再抓 #stop-button");
  assert.ok(!inputSrc.includes("updateInputHint"), "updateInputHint 随 .input-hint 一起删除");
  assert.doesNotMatch(styles, /\.btn-circle-stop/, ".btn-circle-stop 规则已随节点下线");
  assert.doesNotMatch(styles, /\.input-hint\s*[,{]/, ".input-hint 不许有活的规则");
  assert.doesNotMatch(styles, /\.chat-mode-select\s*[,{]/, ".chat-mode-select 不许有活的规则");

  // ① 单宿主 + 四层 glyph，相位写在宿主自己身上；glyph 一律 aria-hidden。
  assert.match(renderSrc, /id="send-input-button"[^\n]*data-phase="idle"[^\n]*aria-label="发送消息"/);
  assert.equal((renderSrc.match(/class="composer-send-glyph composer-send-glyph-/g) ?? []).length, 4, "四层 glyph");
  for (const layer of ["arrow", "stop", "sending", "sent"]) {
    assert.ok(renderSrc.includes(`composer-send-glyph-${layer}`), `缺 ${layer} 层 glyph`);
  }
  assert.match(inputSrc, /type ComposerSendPhase = "idle" \| "sending" \| "sent" \| "failed" \| "running";/);
  assert.match(inputSrc, /sendBtn\.setAttribute\("data-phase", sendPhase\)/);

  // ① morph 段：只用 token，不写字面毫秒，也没有 display 互斥（切换不改变几何）。
  const morphBlock = styles.slice(styles.indexOf("── 发送 ⇄ 停止"), styles.indexOf(".composer-send-spinner"));
  assert.ok(morphBlock.length > 400, "找不到 morph 段");
  assert.doesNotMatch(morphBlock, /\d+ms/, "morph 过渡不许写字面毫秒");
  assert.doesNotMatch(morphBlock, /display:\s*none\s*;/, "交叉淡入不是 display 硬切");
  for (const token of ["--motion-morph", "--motion-fast", "--motion-quick-exit"]) {
    assert.ok(morphBlock.includes(`var(${token})`), `morph 段未消费 ${token}`);
  }

  // ② 驻留时长两边同源：JS 从 motion-tokens 取，CSS 由原位结果行的倒计时下划线消费。
  assert.match(inputSrc, /return phase === "failed" \? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS;/);
  assert.match(
    styles,
    /\.composer-status-line\[data-tone="sent"\]::after\s*\{[^}]*var\(--motion-dwell-sent\)/s,
    "--motion-dwell-sent 必须被原位行消费",
  );
  assert.match(
    styles,
    /\.composer-status-line\[data-tone="failed"\]::after\s*\{[^}]*var\(--motion-dwell-failed\)/s,
    "--motion-dwell-failed 必须被原位行消费（失败驻留 ≥ 成功）",
  );

  // ② 提交链路（sendInputFromBox 全文）：结果只落原位相位，不再落 Toast。
  const submitChain = inputSrc.slice(
    inputSrc.indexOf("export function sendInputFromBox"),
    inputSrc.indexOf("function postStructuredInput"),
  );
  assert.ok(submitChain.length > 1000, "找不到 sendInputFromBox 函数体");
  for (const call of ["flashComposerSending(", "flashComposerDone(", "flashComposerFailed("]) {
    assert.ok(submitChain.includes(call), `提交链路缺 ${call}`);
  }
  assert.doesNotMatch(submitChain, /showToast\(/, "提交链路的失败原因留在原位，不叠气泡");
  const stopBlock = inputSrc.slice(inputSrc.indexOf("export function stopSession"), inputSrc.indexOf("export function stopSession") + 1600);
  assert.match(stopBlock, /flashComposerDone\("已停止/, "停止结果留在原位");
  assert.doesNotMatch(stopBlock, /showToast\(/, "停止的成功/失败都不借气泡");

  // ③ 快捷键教学文案的活宿主：空闲时常驻在原位结果行里（.input-hint 从未有宿主）。
  assert.match(engineSrc, /export const COMPOSER_IDLE_HINT = "Enter 发送 · Shift\+Enter 换行";/);
  assert.match(renderSrc, /id="composer-status-line" role="status" aria-live="polite"[^\n]*COMPOSER_IDLE_HINT/);

  // ⑥ 只有 title 的图标按钮补上可访问名称（WCAG 4.1.2 / 2.1.1）。
  assert.match(renderSrc, /id="terminal-scale-down-top"[^\n]*aria-label="缩小终端字号"/);
  assert.match(renderSrc, /id="terminal-scale-up-top"[^\n]*aria-label="放大终端字号"/);
  assert.match(renderSrc, /id="page-refresh-btn"[^\n]*aria-label="刷新页面"/);
  assert.match(notificationsSrc, /notification-bubble-close"[^\n]*aria-label="关闭这条通知"/);
  assert.match(inputSrc, /queue-item-cancel"[^\n]*aria-label="取消这条排队消息"/);
});

// 用户可见的成句文案统一中文；code fence 里的命令、诊断 key 这类技术标识不在此列。
test("离线横幅不再有英文成句", () => {
  const renderSrc = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  assert.match(
    renderSrc,
    /el\.textContent = ['"]当前处于离线状态，部分功能可能不可用。['"]/,
    "断线横幅是浏览器真的离线时唯一的提示，必须读得懂",
  );
  assert.doesNotMatch(renderSrc, /You are offline/);
});
