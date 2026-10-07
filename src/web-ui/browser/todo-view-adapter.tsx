import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Badge, Card, Flex, List, Progress, Typography } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { normalizeTodoStatus, summarizeTodoProgress, type TodoEntry } from "./todo-progress";

const roots = new Map<HTMLElement, Root>();
function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) if (!node.isConnected) { root.unmount(); roots.delete(node); }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}

/** DOM expansion/focus and native progress remain owned by chat-render. */
export function paintTodoProgress(todos: readonly TodoEntry[]): void {
  const summary = summarizeTodoProgress(todos);
  const count = `${summary.completed} / ${summary.total}`;
  const percent = Math.round(summary.ratio * 100);
  const toggle = document.getElementById("todo-progress-summary");
  const content = document.getElementById("todo-progress-content");
  if (toggle) paint(toggle, <Flex align="center" gap="small" style={{ minWidth: 0 }}>
    <span id="todo-progress-ring"><Progress type="circle" size={24} percent={percent} showInfo={false}/></span>
    <span id="todo-progress-counter" aria-live="polite">{count}</span>
    <Typography.Text id="todo-progress-task" ellipsis>{summary.activeTask || "准备中…"}</Typography.Text>
  </Flex>);
  if (content) paint(content, <Card size="small" title="待办进度" extra={<span id="todo-progress-panel-count">{count}</span>}>
    <div id="todo-progress-fill"><Progress percent={percent} steps={summary.total} size="small" showInfo={false}/></div>
    <List id="todo-progress-list" dataSource={[...todos]} renderItem={todo => {
      const status = normalizeTodoStatus(todo.status);
      return <List.Item aria-current={status === "in_progress" ? "step" : undefined}>
        <Badge status={status === "completed" ? "success" : status === "in_progress" ? "processing" : "default"}
          text={<Typography.Text delete={status === "completed"}>{todo.content || ""}</Typography.Text>}/>
      </List.Item>;
    }}/>
  </Card>);
}
