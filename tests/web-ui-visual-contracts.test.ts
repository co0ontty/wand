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

test("login and shared controls use the approved warm library theme", () => {
  const theme = readFileSync(new URL("../src/web-ui/react/theme.tsx", import.meta.url), "utf8");
  const button = readFileSync(new URL("../src/web-ui/react/ui/button.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("../src/web-ui/react/login/host.tsx", import.meta.url), "utf8");
  assert.match(theme, /colorPrimary: "#b8562f"/);
  assert.match(button, /<Button/);
  assert.match(login, /<Input.Password/);
  assert.match(login, /<Button id="login-button" type="primary"/);
  assert.doesNotMatch(foundationStyles, /\.wand-ui-button \{[^}]*border-radius/);
});

test("sidebar and login share the approved Ant theme owner", () => {
  const shell = readFileSync(new URL("../src/web-ui/react/shell/shell-app.tsx", import.meta.url), "utf8");
  const sidebar = readFileSync(new URL("../src/web-ui/react/shell/shell-sidebar.tsx", import.meta.url), "utf8");
  const theme = readFileSync(new URL("../src/web-ui/react/theme.tsx", import.meta.url), "utf8");
  assert.match(shell, /<WandUiProvider>/);
  assert.match(sidebar, /<Layout.Sider/);
  assert.match(sidebar, /theme="light"/);
  assert.match(theme, /Layout: \{ siderBg: "#f4f0e9"/);
  assert.doesNotMatch(styles, /--web-sidebar-/);
});

test("reduced-motion library popups retain alignment without visible translation or scaling", () => {
  const shared = readFileSync(new URL("../src/web-ui/react/styles/base.ts", import.meta.url), "utf8");
  const theme = readFileSync(new URL("../src/web-ui/react/theme.tsx", import.meta.url), "utf8");
  assert.match(shared, /prefers-reduced-motion: reduce/);
  assert.match(shared, /\.ant-picker-dropdown[^}]*transform: none !important/s);
  assert.match(theme, /motion: true/);
  assert.match(theme, /motionDurationFast: reduced \? "0.00001s"/);
});

test("library popups opt into hit testing above the passive shell portal", () => {
  assert.match(foundationStyles, /#overlay-root \{[^}]*pointer-events: none/);
  assert.match(foundationStyles, /\.wand-ui-portals :is\([^)]*\.ant-dropdown[^)]*\) \{ pointer-events: auto;/);
});

test("the task welcome glyph is a visible Ant Result icon", () => {
  const welcome = readFileSync(new URL("../src/web-ui/react/workspaces/workspace-agent-picker.tsx", import.meta.url), "utf8");
  assert.match(welcome, /<Result icon=\{<WandIcon name="task" size=\{36\}/);
  assert.doesNotMatch(welcome, /color: "white"/);
  const mark = readFileSync(new URL("../src/web-ui/react/ui/brand-mark.tsx", import.meta.url), "utf8");
  assert.match(mark, /width: 24, height: 24/);
});

test("web sidebar uses a create row, two destinations, and a marked session tree", () => {
  const sidebar = readFileSync(new URL("../src/web-ui/react/shell/shell-sidebar.tsx", import.meta.url), "utf8");
  const tree = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /<Flex hidden=\{conversationState\.mode !== "tasks"\} component="nav" vertical gap="small" className="sidebar-feature-nav"/);
  assert.ok(sidebar.indexOf('id="drawer-new-session-button"') < sidebar.indexOf('id="task-board-button"'));
  assert.match(sidebar, /<Flex vertical=\{narrow\} gap="small">/);
  assert.match(sidebar, /id="task-board-button"/);
  assert.match(sidebar, /id="ai-teams-button"/);
  assert.match(sidebar, /<Badge count=\{teamAttention\}/);
  assert.match(tree, /paddingInlineStart: 8.*className="workspace-tasks"/);
  assert.match(tree, /<Badge dot=\{glow !== "none"\}/);
  assert.match(sidebar, /<span hidden=\{narrow\}>任务看板<\/span>/);
});

test("row actions preserve title width and keyboard access", () => {
  const tree = readFileSync(new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tree, /className="workspace-row-actions"|className="workspace-task-actions"/);
  assert.match(tree, /<SidebarRowMenu/);
  const rowMenu = readFileSync(new URL("../src/web-ui/react/workspaces/sidebar-row-menu.tsx", import.meta.url), "utf8");
  assert.match(rowMenu, /event\.key === "ContextMenu" \|\| event\.shiftKey && event\.key === "F10"/);
  assert.match(rowMenu, /onTouchEnd:/);
  assert.match(tree, /className="workspace-task-name"/);
  assert.match(tree, /minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis"/);
  assert.match(tree, /label=\{`任务 \$\{task.name\} 的更多操作`\}/);
  assert.doesNotMatch(styles, /:hover \.workspace-row-actions|workspace-row-actions[^}]*opacity: 0/);
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
// 这里验单宿主、库加载与相位、token 化驻留时长、
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

  // A single host keeps the phase contract; Ant owns loading, icon and colors.
  assert.match(renderSrc, /id="send-input-button"[^\n]*data-phase="idle"[^\n]*aria-label="发送消息"/);
  assert.doesNotMatch(renderSrc, /composer-send-glyph/);
  assert.match(inputSrc, /type ComposerSendPhase = "idle" \| "sending" \| "sent" \| "failed" \| "running";/);
  assert.match(inputSrc, /sendBtn\.setAttribute\("data-phase", sendPhase\)/);
  const controls = readFileSync(new URL("../src/web-ui/browser/library-buttons.tsx", import.meta.url), "utf8");
  assert.match(controls, /loading=\{snapshot\.phase === "sending"\}/);
  assert.match(controls, /danger=\{snapshot\.phase === "running" \|\| snapshot\.phase === "failed"\}/);
  assert.match(controls, /snapshot\.phase === "running" \? "stop" : snapshot\.phase === "sent" \? "check" : "up"/);
  assert.match(inputSrc, /return phase === "failed" \? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS;/);

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
  const stopBlock = inputSrc.slice(inputSrc.indexOf("export function stopSession"), inputSrc.indexOf("export function deleteSession"));
  assert.match(stopBlock, /if \(state\.selectedId === id\) flashComposerDone\(/, "停止结果留在原会话的输入区");
  assert.match(stopBlock, /if \(state\.selectedId === id\)\s*\{\s*flashComposerFailed\(/, "当前会话的停止失败仍显示在原位");

  // ③ 快捷键教学文案的活宿主：空闲时常驻在原位结果行里（.input-hint 从未有宿主）。
  assert.match(engineSrc, /export const COMPOSER_IDLE_HINT = "Enter 发送 · Shift\+Enter 换行";/);
  assert.match(renderSrc, /id="composer-status-line" role="status" aria-live="polite"[^\n]*COMPOSER_IDLE_HINT/);

  // ⑥ 只有 title 的图标按钮补上可访问名称（WCAG 4.1.2 / 2.1.1）。
  assert.match(renderSrc, /id="terminal-scale-down-top"[^\n]*aria-label="缩小终端字号"/);
  assert.match(renderSrc, /id="terminal-scale-up-top"[^\n]*aria-label="放大终端字号"/);
  assert.match(renderSrc, /id="page-refresh-btn"[^\n]*aria-label="刷新页面"/);
  const notices = readFileSync(new URL("../src/web-ui/browser/notice-view-adapter.tsx", import.meta.url), "utf8");
  assert.match(notices, /notification-bubble-close"[^\n]*aria-label="关闭这条通知"/);
  const queue = readFileSync(new URL("../src/web-ui/browser/queue-view-adapter.tsx", import.meta.url), "utf8");
  assert.match(queue, /aria-label="取消这条排队消息"/);
});

// 用户可见的成句文案统一中文；code fence 里的命令、诊断 key 这类技术标识不在此列。
test("离线横幅不再有英文成句", () => {
  const renderSrc = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  const notices = readFileSync(new URL("../src/web-ui/browser/notice-view-adapter.tsx", import.meta.url), "utf8");
  assert.match(notices, /当前处于离线状态，部分功能可能不可用。/);
  assert.match(renderSrc, /paintOfflineNotice\(el\)/);
  assert.doesNotMatch(renderSrc, /You are offline/);
});
