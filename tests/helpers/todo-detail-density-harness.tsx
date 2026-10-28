// Actual product adapters and actual shell top-row DOM. Only transcript/queue data are fixtures.
import { renderAppShell } from "../../src/web-ui/browser/render.js";
import { paintTodoProgress, setTodoProgressExpanded } from "../../src/web-ui/browser/todo-view-adapter.js";
import { paintQueueBar } from "../../src/web-ui/browser/queue-view-adapter.js";
import { installReactUiStyles } from "../../src/web-ui/react/styles.js";
import { setWandTheme } from "../../src/web-ui/react/theme-preference.js";
import type { TodoEntry } from "../../src/web-ui/browser/todo-progress.js";
import type { TodoExecutionPresentation } from "../../src/web-ui/browser/todo-execution.js";

installReactUiStyles();
const template = document.createElement("template");
template.innerHTML = renderAppShell();
const row = template.content.querySelector(".composer-top-row")!;
const fixture = document.getElementById("fixture")!;
fixture.appendChild(row);
const editor = document.createElement("textarea");
editor.id = "draft"; editor.setAttribute("aria-label", "测试草稿"); fixture.appendChild(editor);
const send = document.createElement("button"); send.id = "submit"; send.textContent = "发送（测试禁用）"; send.disabled = true; fixture.appendChild(send);
let queueOpen = false;
let queueItems: string[] = [];
let unintendedActions = 0;
function renderQueue() {
  const host = document.getElementById("queue-bar-host")!;
  host.hidden = queueItems.length === 0;
  paintQueueBar(host, queueItems, true, false, {
    expanded: queueOpen, onExpandedChange(next) { queueOpen = next; renderQueue(); },
    busy: false, retrieval: undefined, removal: undefined, steering: false,
    onAction() { unintendedActions++; }, onDragStart() { unintendedActions++; },
  });
}
const frame = async () => {
  await document.fonts.ready;
  await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  while (document.getAnimations().some(animation => animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().endTime))) {
    await new Promise<void>(done => requestAnimationFrame(() => done()));
  }
};
(window as any).todoDensity = {
  frame, theme: setWandTheme,
  show(todos: TodoEntry[], withQueue = true, execution?: TodoExecutionPresentation) {
    setTodoProgressExpanded(false);
    document.getElementById("todo-progress")!.classList.toggle("hidden", !todos.length);
    paintTodoProgress(todos, execution ?? { sourceKey: "density-fixture-turn", kind: "running", label: "运行中", note: "进度来自本轮工具记录；清单完成不代表执行已结束。" });
    queueItems = withQueue ? ["请保留这条真实协议形状的排队样例，不执行。"] : [];
    queueOpen = false; renderQueue();
  },
  get unintendedActions() { return unintendedActions; },
};
(window as any).todoDensity.show([
  { content: "核对现有组件", status: "completed" },
  { content: "整理待办详情", activeForm: "正在整理详情", status: "in_progress" },
  { content: "等待用户确认", status: "pending" },
  { content: "确认后实施并验收", status: "pending" },
]);
