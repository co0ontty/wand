import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isAmbiguousComposerSubmissionFailure, shouldPersistComposerDraft, shouldPersistQueueItemRestore } from "../src/web-ui/browser/composer-draft.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

// 复现路径：输入文本 → Enter（composer 与 localStorage 同步清空）→ 服务端还在流式
// 响应时刷新页面 → 在途 fetch 被 abort → 失败回填把已经发出去的消息写回 localStorage
// → 刷新后它重新出现在输入框里，用户一按回车就重复发送。
test("传输层失败（刷新/切前后台 abort）视为送达未知：回填只留内存，不落盘", () => {
  const transportFailures: unknown[] = [
    new Error("Failed to fetch"),
    new Error("NetworkError when attempting to fetch resource."),
    new Error("Load failed"),
    new Error("The operation was aborted."),
    new Error("TypeError: NetworkError"),
    { __wandAmbiguousDelivery: true },
    { errorCode: "duplicate_idempotency_key" },
    // 幂等拦截带 409，但消息其实已经在处理 / 已经在排队：不能被当成「没送到」。
    { errorCode: "duplicate_idempotency_key", httpStatus: 409 },
    { errorCode: "duplicate_queued_message", httpStatus: 409, message: "与上一条消息相同，已忽略，不会加入排队。" },
  ];
  for (const failure of transportFailures) {
    assert.equal(isAmbiguousComposerSubmissionFailure(failure), true, String((failure as Error).message));
  }
  // 回填走内存（persist=false）：当前页面能看到、能改写，刷新后不会复活。
  assert.equal(shouldPersistComposerDraft(false, false), false);
  assert.equal(shouldPersistComposerDraft(false, true), false);
});

test("明确失败（HTTP 4xx/5xx、本地前置条件）不算送达未知：草稿回填并持久化", () => {
  const definiteFailures: unknown[] = [
    Object.assign(new Error("无法发送结构化消息。"), { httpStatus: 500 }),
    Object.assign(new Error("invalid input"), { httpStatus: 400, errorCode: "invalid_input" }),
    new Error("网络已断开，消息未发送，原草稿已恢复。"),
    new Error("发送前会话已切换，原草稿已恢复。"),
    new Error("会话尚未准备好，消息未发送。"),
    undefined,
    null,
    {},
  ];
  for (const failure of definiteFailures) {
    assert.equal(isAmbiguousComposerSubmissionFailure(failure), false, String((failure as Error)?.message));
  }
  // 明确没送达：必须落盘，用户刷新后还能找回这段文字。
  assert.equal(shouldPersistComposerDraft(!isAmbiguousComposerSubmissionFailure(definiteFailures[0]), true), true);
});

test("shouldPersistComposerDraft：只有显式 true 才会在页面卸载期间写 localStorage", () => {
  assert.equal(shouldPersistComposerDraft(false, false), false);
  assert.equal(shouldPersistComposerDraft(false, true), false);
  assert.equal(shouldPersistComposerDraft(true, false), true);
  assert.equal(shouldPersistComposerDraft(true, true), true);
  assert.equal(shouldPersistComposerDraft(undefined, false), true);
  assert.equal(shouldPersistComposerDraft(undefined, true), false);
});

test("input.ts 按送达确定性决定回填是否落盘", () => {
  const input = source("src/web-ui/browser/input.ts");
  assert.match(input, /import \{[^}]*isAmbiguousComposerSubmissionFailure[^}]*\} from "\.\/composer-draft"/);
  assert.match(
    input,
    /restoreFailedComposerSubmission\([\s\S]{0,220}?isAmbiguousComposerSubmissionFailure\(err\)/,
    "sendInputFromBox 的失败回填必须带上「送达是否未知」判定",
  );
  assert.match(input, /error\.__wandAmbiguousDelivery = true;/, "structured 传输层失败要打标记");
});

test("session-engine 的草稿写入区分三态并支持彻底清除", () => {
  const engine = source("src/web-ui/browser/session-engine.ts");
  assert.match(engine, /shouldPersistComposerDraft\(persist, !!state\.pageUnloading\)/);
  assert.match(engine, /state\.draftsMemoryOnly\[sessionId\] = true/);
  assert.match(engine, /export function clearDraftValueForSession/);
  assert.match(engine, /delete state\.draftsMemoryOnly\[sessionId\]/);
  assert.match(engine, /persistPreviousDraft = !state\.draftsMemoryOnly\[previousSessionId\]/);
});

test("新建 / 恢复会话时草稿被整条清除，不留下 localStorage 旧值", () => {
  const input = source("src/web-ui/browser/input.ts");
  const adapter = source("src/web-ui/browser/new-session-adapter.ts");
  for (const [file, text] of [["input.ts", input], ["new-session-adapter.ts", adapter]] as const) {
    assert.equal(
      /state\.drafts\[[^\]]+\] = ""/.test(text),
      false,
      `${file} 不能只清内存草稿 —— localStorage 里的旧值会在刷新后复活`,
    );
  }
  assert.ok(input.includes("clearDraftValueForSession(data.id)"), "input.ts 新建/恢复会话要清 localStorage");
  assert.ok(adapter.includes("clearDraftValueForSession(created.id"), "new-session-adapter 新建会话要清 localStorage");
});

// 同一 bug 家族的第二个位置：跨会话排队（localStorage["wand-cross-session-queue"]）。
// 出队交给 /api/commands 时如果只改内存不落盘，多条目场景下旧队首会留在 localStorage
// 里；刷新后它被重新 flush → 同一条消息发出两遍（多一个会话）。失败回填则相反：
// 页面卸载中的 abort 属于送达未知，落盘同样会让它在刷新后二次发送。
test("跨会话排队：出队立刻落盘，卸载中的失败回填只留内存", () => {
  const input = source("src/web-ui/browser/input.ts");
  const flush = input.slice(input.indexOf("export function flushCrossSessionQueue"));
  assert.match(
    flush.slice(0, 600),
    /var item = state\.crossSessionQueue\.shift\(\);[\s\S]{0,400}?persistCrossSessionQueue\(\);/,
    "flushCrossSessionQueue 出队后必须立刻 persist，否则旧队首会在刷新后复活",
  );
  assert.equal(
    (input.match(/if \(shouldPersistQueueItemRestore\(!!state\.pageUnloading\)\) persistCrossSessionQueue\(\);/g) || []).length,
    3,
    "launchQueueItem（并发守卫回填 + 失败回填）/ sendQueueItemNow 都要按卸载状态决定是否落盘",
  );
  assert.equal(shouldPersistQueueItemRestore(false), true);
  assert.equal(shouldPersistQueueItemRestore(true), false);
});

// 同一 bug 家族的第三个位置：结构化会话的同会话排队（localStorage["wand-structured-queue"]）。
// 队列排空后只写不清，旧文本会永久留在 localStorage 里；刷新时如果当前会话快照
// 不带 queuedMessages 字段（历史 / 精简会话），restoreStructuredQueue 就回退到这份
// 旧值，把「已经发出去的消息」当成待排队气泡重新画在输入框上方。
test("结构化排队：队列排空时清掉 localStorage，不留可复活的旧值", () => {
  const chatScroll = source("src/web-ui/browser/chat-scroll.ts");
  const save = chatScroll.slice(
    chatScroll.indexOf("export function saveStructuredQueue"),
    chatScroll.indexOf("export function clearStructuredQueuePersistence"),
  );
  assert.match(
    save,
    /queued\.length === 0[\s\S]{0,600}?clearStructuredQueuePersistence\(state\.selectedId\)/,
    "队列为空必须删掉持久化记录，否则刷新后它会被 restoreStructuredQueue 当待排队复活",
  );
  assert.match(save, /if \(!state\.selectedId\) return;/, "没有选中会话时不要误删其它会话的排队记录");
  const restore = chatScroll.slice(chatScroll.indexOf("export function restoreStructuredQueue"));
  // 读取侧的第二道防线：会话已知且已停止时不再信任 localStorage 里的排队记录
  // （排队只存在于 turn 执行中，服务端在 turn 结束 / 退出时清空并推送）。
  assert.match(
    restore,
    /selectedSession\.status !== "running"[\s\S]{0,220}?clearStructuredQueuePersistence\(selectedSession\.id\)/,
    "已停止的会话不能从 localStorage 复活排队气泡",
  );
  // 回退读取只在会话快照缺 queuedMessages 时才发生 —— 这正是旧值会露头的场景。
  assert.match(
    restore,
    /if \(selectedSession && Array\.isArray\(selectedSession\.queuedMessages\)\)[\s\S]{0,900}?state\.structuredInputQueue = parsed\.items\.slice\(0, 10\)/,
  );
});

test("页面卸载期间隐式草稿写入被跳过，pageshow 复位标记", () => {
  const stateSource = source("src/web-ui/browser/state.ts");
  assert.match(stateSource, /pageUnloading: false/);
  assert.match(stateSource, /draftsMemoryOnly: \{\}/);
  assert.match(stateSource, /addEventListener\("pagehide", markUnloading\)/);
  assert.match(stateSource, /addEventListener\("beforeunload", markUnloading\)/);
  assert.match(stateSource, /addEventListener\("pageshow", function\(\) \{ state\.pageUnloading = false; \}\)/);
});
