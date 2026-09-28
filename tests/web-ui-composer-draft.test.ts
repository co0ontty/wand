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

// 直通模式（键盘输入即透传）不走普通提交链路，失败原本被 .catch(function(){}) 吞掉。
test("终端直通提交失败：原位结果行不可见时退回错误气泡，并把没送出的字放回输入框", () => {
  const input = source("src/web-ui/browser/input.ts");
  assert.match(
    input,
    /return queueDirectInput\(passthroughText, "interactive_text"\)[\s\S]{0,200}?\.catch\(function\(err\) \{\n\s*\/\/[\s\S]{0,400}?reportPassthroughInputFailure\(passthroughSessionId, passthroughText, err\);/,
    "有文本的直通提交失败必须交给统一播报，不能再空 catch",
  );
  assert.match(
    input,
    /return queueDirectInput\("\\r", "enter_text"\)\.catch\(function\(err\) \{[\s\S]{0,200}?reportPassthroughInputFailure\(passthroughSessionId, "", err\);/,
    "空回车失败同样要响一声",
  );
  assert.match(
    input,
    /function reportPassthroughInputFailure\(sessionId, text, error\) \{[\s\S]*?restoreFailedComposerSubmission\(sessionId, text, \[\], false\);[\s\S]*?flashComposerFailed\(/,
    "回填只留内存（送达未知），原因走 flashComposerFailed",
  );
  const passthroughStart = input.indexOf('if (state.terminalInteractive && !embedTerminal) {');
  assert.ok(passthroughStart >= 0, "直通分支还在 sendInputFromBox 里");
  assert.doesNotMatch(
    input.slice(passthroughStart, input.indexOf("var inputBox =", passthroughStart)),
    /\.catch\(function\(\) \{\}\)/,
    "直通分支里不许留空 catch",
  );
});

// 一次失败留在 state.inputQueue 上，之后每次 queueDirectInput 的 .then 都会被跳过。
test("queueDirectInput：单次失败不污染队列，失败只交给调用方播报", () => {
  const input = source("src/web-ui/browser/input.ts");
  assert.match(
    input,
    /var queued = state\.inputQueue\.then\(function\(\) \{/,
    "排队 promise 与队列本身分开持有",
  );
  assert.match(
    input,
    /state\.inputQueue = queued\.catch\(function\(\) \{\}\);\n\s*return queued;/,
    "队列自身保持 fulfilled，返回给调用方的 promise 仍然带失败",
  );
});

// readyState===OPEN 与 send() 成功之间没有保证：连接正在关闭时浏览器会同步抛
// InvalidStateError。裸调用发生在 Promise 之外，会绕过调用方的 .catch 变成静默丢失。
test("queueDirectInput：WS 快路径的同步抛转成同一条 rejection，不新增第二条播报", () => {
  const input = source("src/web-ui/browser/input.ts");
  const fastPath = input.slice(input.indexOf('if (effectiveView === "terminal"'), input.indexOf("state.messageQueue.push(input);"));
  assert.ok(fastPath.length > 80, "没截到 WS 快路径");
  assert.match(
    fastPath,
    /try \{\n\s*state\.ws\.send\(JSON\.stringify\(\{[\s\S]*?\}\)\);\n\s*\} catch \(error\) \{\n\s*return Promise\.reject\(error\);\n\s*\}/,
    "send 必须整个包在 try 里，抛错转成这一条链路的 rejection",
  );
  // 注释里会提到播报函数名（解释为什么不在这里播报），所以只看代码。
  const fastPathCode = fastPath.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(fastPathCode, /flashComposer|showToast|reportPassthroughInputFailure/,
    "快路径不许自己播报：播报只挂在调用方的 .catch 上，同步抛与异步 reject 共用同一出口，各一次");
});

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

// Draft ownership, unloading policy, and delivery rollback are exercised through
// ComposerStore in web-ui-composer-state.test.ts rather than its implementation.

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
  assert.match(stateSource, /addEventListener\("pagehide", markUnloading\)/);
  assert.match(stateSource, /addEventListener\("beforeunload", markUnloading\)/);
  assert.match(stateSource, /addEventListener\("pageshow", function\(\) \{ state\.pageUnloading = false; \}\)/);
});
