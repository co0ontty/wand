import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskDatePicker } from "../src/web-ui/react/issues/form-controls.js";
import { TaskBoardCardDetail } from "../src/web-ui/react/issues/task-board-views.js";
import { WandUiProvider } from "../src/web-ui/react/theme.js";
import type { WandTaskListed } from "../src/web-ui/react/issues/task-board-repository.js";

function render(child: Parameters<typeof createElement>[0], props: object): string {
  return renderToStaticMarkup(createElement(WandUiProvider, null, createElement(child, props)));
}

test("task calendar renders date-only leap days and empty values through the library", () => {
  const date = render(TaskDatePicker, { value: "2040-02-29", ariaLabel: "Deadline", onValueChange() {} });
  assert.match(date, /ant-picker/);
  assert.match(date, /value="2040-02-29"/);
  assert.doesNotMatch(date, /type="date"/);
  const empty = render(TaskDatePicker, { value: "", ariaLabel: "Deadline", onValueChange() {} });
  assert.match(empty, /value=""/);
});

test("expanded task card exposes every label, project path and session identity", () => {
  const task = {
    id: "task", identifier: "TASK-1", title: "Card", description: "Complete instructions",
    labels: ["First", "Second", "Third", "Fourth"], status: "doing", priority: "high",
    dueDate: "2040-02-29", workspace: { id: "workspace", name: "Project", cwd: "/tmp/project" },
    agent: null, milestone: null, updatedAt: "2026-01-01",
    sessions: [{ id: "actual-session", provider: "codex", model: "gpt-5", title: "Real session",
      status: "idle", sessionKind: "structured", cwd: "/tmp/project/worktree", thinkingEffort: "high" }],
  } as WandTaskListed;
  const markup = render(TaskBoardCardDetail, { task, open: true, childCount: 0, onOpen() {}, onCollapse() {} });
  for (const text of [...task.labels, task.description, task.workspace!.cwd, task.sessions[0]!.cwd, "Real session"]) {
    assert.ok(markup.includes(text), `full detail includes ${text}`);
  }
  assert.match(markup, /ant-tag/);
  assert.match(markup, /task-card-detail-task/);
  const closed = render(TaskBoardCardDetail, { task, open: false, childCount: 0, onOpen() {}, onCollapse() {} });
  assert.match(closed, /inert=""/);
});
