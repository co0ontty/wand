import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { WandUiProvider } from "../react/theme";
import { WandIcon, WandPopover } from "../react/ui";
import { ComposerWorkPanel, ComposerWorkSummary, ComposerWorkText } from "../react/composer-work-panel.js";
import { normalizeTodoStatus, summarizeTodoProgress, type TodoEntry } from "./todo-progress";
import type { TodoExecutionPresentation } from "./todo-execution.js";

let host: HTMLElement | null = null;
let root: Root | null = null;
let entries: readonly TodoEntry[] = [];
let execution: TodoExecutionPresentation | null = null;
let expanded = false;
export function isTodoProgressExpanded(): boolean { return expanded; }
export function setTodoProgressExpanded(next: boolean, focus = false): void {
  if (expanded === next) return;
  expanded = next;
  if (next) document.dispatchEvent(new CustomEvent("wand-composer-work-popup", { detail: "todo" }));
  render();
  if (focus) document.getElementById("todo-progress-toggle")?.focus({ preventScroll: true });
}
function TodoProgress({ todos, context }: { todos: readonly TodoEntry[]; context: TodoExecutionPresentation | null }) {
  const summary = summarizeTodoProgress(todos);
  const count = `${summary.completed}/${summary.total}`;
  React.useEffect(() => {
    const other = (event: Event) => { if ((event as CustomEvent).detail !== "todo") setTodoProgressExpanded(false); };
    document.addEventListener("wand-composer-work-popup", other);
    return () => document.removeEventListener("wand-composer-work-popup", other);
  }, []);
  if (!context) return null;
  const running = context.kind === "running";
  const label = context.kind === "ended" ? "已结束" : context.kind === "failed" ? "失败" : context.label;
  const recorded = todos.find(todo => normalizeTodoStatus(todo.status) === "in_progress")
    ?? todos.find(todo => normalizeTodoStatus(todo.status) === "pending");
  const preview = summary.allDone ? "清单已完成" : running ? summary.activeTask || "尚无当前项" : recorded?.content || "只读记录";
  return <WandPopover open={expanded} onOpenChange={setTodoProgressExpanded} side="top" align="center" className="composer-work-popover composer-todo-popover"
    contentId="todo-progress-body" contentRole="dialog" popupOwner="composer-todo" ariaLabel="本轮待办进度"
    trigger={React.cloneElement(ComposerWorkSummary({ label: `待办 ${label}`, count, preview, icon: "task", expanded, id: "todo-progress-toggle", className: "todo-progress-header" }), {
      "aria-label": `待办，${context.label}，已完成 ${count}，${preview}，查看详情`, "aria-controls": "todo-progress-body",
    })}>
    <ComposerWorkPanel className="composer-todo-panel" title={`待办 · 已完成 ${count}`}
      description={running ? summary.allDone ? "清单已完成，不代表执行结束或任务验收通过。" : undefined : `${context.label} · ${context.note}`}
      onClose={() => setTodoProgressExpanded(false, true)}>
      <ol className="composer-todo-list" id="todo-progress-list" data-execution={context.kind}>{todos.map((todo, index) => {
        const status = normalizeTodoStatus(todo.status);
        return <li key={`${context.sourceKey}:${index}:${todo.content}`} data-status={!running && status === "in_progress" ? "pending" : status} data-recorded-status={status} aria-current={running && status === "in_progress" ? "step" : undefined}>
          <span className="composer-todo-icon" role="img" aria-label={status === "completed" ? "已完成" : status === "in_progress" ? running ? "进行中" : "最后记录项，非运行信号" : "待处理"}><WandIcon name={status === "completed" ? "check" : "circle"} size={16}/></span>
          <div data-short={(todo.content || "").length <= 60}>{status === "in_progress" && <span className="composer-todo-status">{running ? `当前 · 第 ${index + 1} 项` : `最后记录 · 第 ${index + 1} 项`}</span>}<ComposerWorkText text={todo.content || "（未提供任务正文）"}/></div>
        </li>;
      })}</ol>
    </ComposerWorkPanel>
  </WandPopover>;
}
function render(): void {
  if (!root || !host?.isConnected) return;
  flushSync(() => root!.render(<WandUiProvider><TodoProgress todos={entries} context={execution}/></WandUiProvider>));
}
export function paintTodoProgress(todos: readonly TodoEntry[], context: TodoExecutionPresentation | null): void {
  const nextHost = document.getElementById("todo-progress");
  if (!nextHost) return;
  if (host !== nextHost) {
    root?.unmount(); host = nextHost; root = createRoot(host); expanded = false;
  }
  if (execution?.sourceKey !== context?.sourceKey) expanded = false;
  entries = todos;
  execution = context;
  render();
}
