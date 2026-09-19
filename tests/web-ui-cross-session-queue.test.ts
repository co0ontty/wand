import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { directChildAnchor, resolveInsertBeforeAnchor } from "../src/web-ui/browser/queue-dom.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

// 极简 DOM 替身：只保留 parentNode 链，用来验证锚点上溯。
type FakeNode = { parentNode: FakeNode | null };
function node(parent: FakeNode | null): FakeNode {
  return { parentNode: parent };
}
function attach(parent: FakeNode, child: FakeNode): FakeNode {
  child.parentNode = parent;
  return child;
}

// 复现路径：会话视图里 flush 队列（剩 ≥1 条）→ renderCrossSessionQueue 把状态栏 /
// 输入框当作 insertBefore 参照 → 这两者都埋在 .input-panel 更深一层 →
// NotFoundError 从 flush 抛回 loadSessions 的 promise 链 → 已经 shift + persist
// 出队的消息再也不会被 launchQueueItem 发送。
test("锚点解析：状态栏 / 输入框都上溯成 .input-panel 的直接子节点", () => {
  const inputPanel = node(null);
  const topRow = attach(inputPanel, node(null)); // .composer-top-row
  const statusBar = attach(topRow, node(null)); // .structured-status-bar
  const composerRow = attach(inputPanel, node(null));
  const composer = attach(composerRow, node(null)); // .input-composer

  // 状态栏优先：解析出的锚点是 topRow，而不是状态栏本身（那样 insertBefore 会抛）。
  assert.notEqual(directChildAnchor(inputPanel, statusBar), statusBar);
  assert.equal(directChildAnchor(inputPanel, statusBar), topRow);
  assert.equal(resolveInsertBeforeAnchor(inputPanel, [statusBar, composer]), topRow);
  // 状态栏缺失时退回输入框所在的直接子节点。
  assert.equal(resolveInsertBeforeAnchor(inputPanel, [null, composer]), composerRow);
  // 两者都没有 → null，调用方退回 append，绝不把非法参照交给 insertBefore。
  assert.equal(resolveInsertBeforeAnchor(inputPanel, [null, null]), null);
});

test("锚点解析：子树外 / 空值 / 自身都不作为锚点", () => {
  const inputPanel = node(null);
  const stray = node(null); // 完全不在 inputPanel 子树内
  const other = node(null);
  const foreign = attach(other, node(null));

  assert.equal(directChildAnchor(inputPanel, stray), null);
  assert.equal(resolveInsertBeforeAnchor(inputPanel, [foreign, stray]), null);
  assert.equal(directChildAnchor(inputPanel, null), null);
  assert.equal(directChildAnchor(null, stray), null);
  assert.equal(resolveInsertBeforeAnchor(null, [stray]), null);
  // node === parent：自身不能当自己的参照。
  assert.equal(directChildAnchor(inputPanel, inputPanel), null);
});

test("锚点解析：直接子节点原样返回", () => {
  const inputPanel = node(null);
  const topRow = attach(inputPanel, node(null));
  assert.equal(directChildAnchor(inputPanel, topRow), topRow);
});

// 同一 bug 家族的第二个位置：flushCrossSessionQueue 出队后先渲染再启动。
// 渲染一旦抛错（或渲染过程中重入第二次 flush），队首已经从内存 + localStorage
// 双重出队却还没交给 /api/commands —— 消息永久蒸发。
// 极简去注释：把整行注释与行尾注释剥掉，避免注释里的函数名干扰定位。
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//")) return "";
      return line.replace(/\/\/.*$/, "");
    })
    .join("\n");
}

test("flushCrossSessionQueue 先启动再渲染，队首不会因为渲染失败而消失", () => {
  const input = source("src/web-ui/browser/input.ts");
  const flush = input.slice(input.indexOf("export function flushCrossSessionQueue"));
  const body = stripComments(flush.slice(0, flush.indexOf("\n      }")));

  const shiftAt = body.indexOf("state.crossSessionQueue.shift()");
  const persistAt = body.indexOf("persistCrossSessionQueue()");
  const launchAt = body.indexOf("launchQueueItem(item)");
  const renderAt = body.indexOf("renderCrossSessionQueue()");
  assert.ok(shiftAt >= 0 && persistAt >= 0 && launchAt >= 0 && renderAt >= 0, "flush 体必须包含出队 / 落盘 / 启动 / 渲染");
  assert.ok(shiftAt < persistAt, "必须先出队再落盘");
  assert.ok(persistAt < launchAt, "落盘后要立刻认领启动（launchQueueItem 同步置位守卫）");
  assert.ok(launchAt < renderAt, "渲染必须排在启动之后，渲染异常不能再吞掉这条消息");
  assert.equal(body.match(/renderCrossSessionQueue\(\)/g)?.length, 1, "flush 只应渲染一次");
});

test("launchQueueItem 撞上并发守卫时把消息放回队首，绝不静默丢弃", () => {
  const input = source("src/web-ui/browser/input.ts");
  const start = input.indexOf("function launchQueueItem(item)");
  assert.ok(start > 0, "launchQueueItem 必须存在");
  const body = stripComments(input.slice(start, input.indexOf("function sendQueueItemNow")));
  assert.match(
    body,
    /if \(_queueLaunching\) \{[\s\S]{0,400}?state\.crossSessionQueue\.unshift\(item\);[\s\S]{0,200}?return;/,
    "守卫分支必须回填队首",
  );
  assert.equal(
    /if \(_queueLaunching\) return;/.test(body),
    false,
    "launchQueueItem 内不能保留「守卫直接 return」的丢消息写法",
  );
});

test("renderCrossSessionQueue 是展示层：内部异常被收敛，不抛回调用链", () => {
  const input = source("src/web-ui/browser/input.ts");
  const start = input.indexOf("export function renderCrossSessionQueue()");
  const wrapper = input.slice(start, start + 600);
  assert.match(wrapper, /try \{[\s\S]{0,200}?renderCrossSessionQueueUnsafe\(\);[\s\S]{0,200}?\} catch \(error\) \{/, "渲染要包 try/catch");
  assert.match(wrapper, /console\.error\("\[wand\] cross-session queue render failed:", error\)/, "失败要留日志");

  // insertBefore 参照必须经过锚点解析，不能直接拿状态栏 / 输入框。
  const renderBody = input.slice(input.indexOf("function renderCrossSessionQueueUnsafe()"));
  assert.match(renderBody, /resolveInsertBeforeAnchor\(parent, \[statusBar, composer\]\)/, "insertBefore 参照要走锚点解析");
  assert.equal(
    /var insertBefore = isInputPanelVisible \? \(statusBar \|\| composer\) : null;/.test(input),
    false,
    "旧的裸参照写法必须删掉",
  );
  assert.match(
    input,
    /import \{ resolveInsertBeforeAnchor \} from "\.\/queue-dom";/,
    "input.ts 要引用 queue-dom 的锚点解析",
  );
});
