import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * `renderAppShell()` 的种子 markup 是拼接出来的 HTML 字符串，React 外壳只把
 * `.input-panel` 等槽位的 **子节点** 搬进 React 根（见 `shell-runtime.ts` 的
 * `createLegacyRefs`），随后 `app.replaceChildren()` 丢掉其余旧节点。
 *
 * 因此种子里的标签一旦不平衡，`.input-panel` 会提前闭合，紧跟其后的浮层
 * （加号 popover、语音气泡、`#action-error`、skills picker）会变成被丢弃的
 * 兄弟节点 —— 表现为「按钮点了没反应」「错误提示永远不显示」，但不会报错。
 * 这组断言把该不变量钉在源码层。
 */

const RENDER_SOURCE = readFileSync(
  new URL("../src/web-ui/browser/render.ts", import.meta.url),
  "utf8",
);

/** 行注释会干扰标签计数（注释里常写示例标签），先整行剥离。 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} 必须存在`);
  const rest = source.slice(start);
  const nextExport = rest.slice(1).search(/\n[ \t]*export (function|const|class|interface|type)\s/);
  return nextExport === -1 ? rest : rest.slice(0, nextExport + 1);
}

const SHELL_BODY = stripLineComments(extractFunctionBody(RENDER_SOURCE, "renderAppShell"));

/** `.input-panel` 在种子里的闭合偏移，用于判断哪些节点仍属于输入面板。 */
function findInputPanelEnd(markup: string): number {
  const openAt = markup.indexOf('<div class="input-panel');
  assert.notEqual(openAt, -1, "种子必须包含 .input-panel");
  const tag = /<\/?div\b/g;
  tag.lastIndex = openAt;
  let depth = 0;
  for (let match = tag.exec(markup); match; match = tag.exec(markup)) {
    depth += match[0] === "<div" ? 1 : -1;
    if (depth === 0) return match.index;
  }
  assert.fail(".input-panel 在种子里没有闭合");
}

test("种子的 div 标签在 renderAppShell 内保持平衡", () => {
  const open = SHELL_BODY.match(/<div\b/g)?.length ?? 0;
  const close = SHELL_BODY.match(/<\/div>/g)?.length ?? 0;
  assert.equal(open, close, `renderAppShell 的 <div>(${open}) 与 </div>(${close}) 数量必须相等`);
});

test(".input-panel 之后的浮层仍留在输入面板内", () => {
  const panelEnd = findInputPanelEnd(SHELL_BODY);
  const floating: readonly [string, string][] = [
    ["加号 popover", '<div class="composer-plus-popover'],
    ["错误条宿主", 'data-composer-action-error-host="main"'],
    ["附件预览宿主", 'data-composer-attachments-host="main"'],
    ["语音气泡宿主", 'data-composer-voice-host="main"'],
    ["skills 弹层宿主", 'data-composer-skills-host="main"'],
  ];
  for (const [label, needle] of floating) {
    const at = SHELL_BODY.indexOf(needle);
    assert.notEqual(at, -1, `${label} 必须在种子中渲染`);
    assert.ok(at < panelEnd, `${label} 落在 .input-panel 之外，会被 replaceChildren() 丢弃`);
  }
});

test("输入面板内保留了三个 composer 配置宿主", () => {
  const scopes = [...SHELL_BODY.matchAll(/data-composer-config-host="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scopes, ["mode", "runtime", "all"]);
  const panelEnd = findInputPanelEnd(SHELL_BODY);
  for (const match of SHELL_BODY.matchAll(/data-composer-config-host="([a-z]+)"/g)) {
    assert.ok((match.index ?? 0) < panelEnd, `composer 配置宿主 ${match[1]} 必须在输入面板内`);
  }
});

test("输入面板不再出现已迁移到 React 的旧渲染函数", () => {
  for (const legacy of [
    "renderComposerConfigControlsHtml",
    "renderComposerSelectHost",
    "renderAutoApproveChip",
    "renderApprovalStatsBadge",
    "renderClaudeSkillsPickerHtml",
  ]) {
    assert.ok(!SHELL_BODY.includes(legacy), `${legacy} 应已由 React portal 取代`);
  }
});

test("加号 popover 只留条目宿主，两个条目与分隔线顺序不变", () => {
  assert.ok(
    SHELL_BODY.includes('<span class="plus-popover-items-host" data-composer-popover-host="items">'),
    "popover 条目宿主必须存在",
  );
  for (const moved of ['id="plus-attach-item"', 'id="terminal-interactive-toggle-top"']) {
    assert.ok(!SHELL_BODY.includes(moved), `${moved} 应由 React portal 渲染，不能留在 seed 里`);
  }
  const popoverAt = SHELL_BODY.indexOf('<div class="composer-plus-popover');
  const hostAt = SHELL_BODY.indexOf('data-composer-popover-host="items"');
  const sepAt = SHELL_BODY.indexOf('<div class="plus-popover-sep"');
  assert.ok(popoverAt !== -1 && hostAt > popoverAt, "条目宿主必须在 popover 容器内");
  assert.ok(sepAt > hostAt, "分隔线应排在被 React 接管的两个条目之后");
  assert.ok(hostAt < findInputPanelEnd(SHELL_BODY), "条目宿主必须在 .input-panel 内");
});
