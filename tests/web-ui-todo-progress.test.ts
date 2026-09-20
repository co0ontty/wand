import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildTodoItemsHtml,
  buildTodoSegmentsHtml,
  normalizeTodoStatus,
  summarizeTodoProgress,
  todoStateClass,
} from "../src/web-ui/browser/todo-progress.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normalizeTodoStatus 把缺失/拼错的状态收敛成 pending", () => {
  assert.equal(normalizeTodoStatus(undefined), "pending");
  assert.equal(normalizeTodoStatus(""), "pending");
  assert.equal(normalizeTodoStatus("Blocked"), "pending");
  assert.equal(normalizeTodoStatus("pending"), "pending");
  assert.equal(normalizeTodoStatus("in_progress"), "in_progress");
  assert.equal(normalizeTodoStatus("completed"), "completed");
});

test("状态到 class 的映射在列表行 / 图标 / 分段进度三处共用", () => {
  assert.equal(todoStateClass("completed"), "done");
  assert.equal(todoStateClass("in_progress"), "active");
  assert.equal(todoStateClass("pending"), "pending");
  assert.equal(todoStateClass(undefined), "pending");
  // 拼错的状态同样落到 pending，不会渲染出一个没有 class 的行。
  assert.equal(todoStateClass("Blocked"), "pending");
});

test("summarizeTodoProgress 统计完成数并挑出当前任务", () => {
  const summary = summarizeTodoProgress([
    { content: "A", status: "completed" },
    { content: "B", status: "completed" },
    { content: "C", activeForm: "正在做 C", status: "in_progress" },
    { content: "D", status: "pending" },
  ]);
  assert.deepEqual(
    { total: summary.total, completed: summary.completed, inProgress: summary.inProgress },
    { total: 4, completed: 2, inProgress: 1 },
  );
  assert.equal(summary.activeTask, "正在做 C");
  assert.equal(summary.ratio, 0.5);
  assert.equal(summary.allDone, false);
});

test("没有进行中项时当前任务回退到下一条 pending，全空则留空", () => {
  // 模型漏发 activeForm / 首条 TodoWrite 全是 pending 时的兜底。
  const fallback = summarizeTodoProgress([
    { content: "A", status: "completed" },
    { content: "B", status: "pending" },
  ]);
  assert.equal(fallback.activeTask, "B");
  assert.equal(summarizeTodoProgress([]).activeTask, "");
  assert.equal(summarizeTodoProgress([]).allDone, false);
  assert.equal(summarizeTodoProgress([]).ratio, 0);
});

test("全部完成时 allDone 才为真", () => {
  assert.equal(summarizeTodoProgress([{ content: "A", status: "completed" }]).allDone, true);
  assert.equal(summarizeTodoProgress([{ content: "A", status: "in_progress" }]).allDone, false);
});

test("清单一行的状态 class、aria 与图标严格对应，且有且只有一个图标", () => {
  const html = buildTodoItemsHtml([
    { content: "做完的", status: "completed" },
    { content: "正在做的", status: "in_progress" },
    { content: "还没做的", status: "pending" },
  ]);
  const rows = html.split("</li>").filter(Boolean);
  assert.equal(rows.length, 3);

  // 每行恰好一个 svg：旧实现除了 SVG 还在 CSS 里用 ::after 画了第二个勾/圆点，
  // 两层叠在 18px 的框里糊成一团。
  for (const row of rows) {
    assert.equal(row.match(/<svg/g)?.length, 1, row);
  }
  assert.match(rows[0], /class="todo-progress-item done"/);
  assert.match(rows[0], /class="todo-item-icon done"/);
  assert.ok(!rows[0].includes("aria-current"));
  assert.match(rows[1], /class="todo-progress-item active"/);
  assert.match(rows[1], /class="todo-item-icon active"/);
  assert.match(rows[1], /aria-current="step"/);
  assert.match(rows[2], /class="todo-progress-item pending"/);
  assert.match(rows[2], /class="todo-item-icon pending"/);
  // 完成态用勾、其它两态用圆，不靠颜色区分形状。
  assert.match(rows[0], /<path d="M20 6 9 17l-5-5"\/>/);
  assert.match(rows[1], /<circle cx="12" cy="12" r="7"\/>/);
  assert.match(rows[2], /<circle cx="12" cy="12" r="7"\/>/);
});

test("任务文案转义，不会被模型输出注入 HTML", () => {
  const html = buildTodoItemsHtml([
    { content: '<img src=x onerror="alert(1)">', status: "pending" },
  ]);
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("分段进度一段一项，段类名跟状态一致", () => {
  const html = buildTodoSegmentsHtml([
    { status: "completed" },
    { status: "in_progress" },
    { status: "pending" },
    { status: undefined },
  ]);
  const segs = html.match(/todo-progress-seg (\w+)/g) || [];
  assert.deepEqual(segs, [
    "todo-progress-seg done",
    "todo-progress-seg active",
    "todo-progress-seg pending",
    "todo-progress-seg pending",
  ]);
});

test("图标装饰只画一层：CSS 不再给 .todo-item-icon 加 ::after", () => {
  const css = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");
  const decorations = css.match(/\.todo-item-icon[^{,]*::(?:after|before)/g) || [];
  assert.deepEqual(decorations, [], "图标装饰请在 iconSvg 里换形状，不要叠 CSS 伪元素");
});
