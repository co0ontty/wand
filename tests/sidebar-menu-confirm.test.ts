import assert from "node:assert/strict";
import test from "node:test";
import { overlayStore } from "../src/web-ui/react/overlay-controller.js";
import { confirmClearSessions, confirmSidebarAction } from "../src/web-ui/react/workspaces/sidebar-menu-confirm.js";

function dialog() {
  const entry = overlayStore.getSnapshot().activeDialog;
  assert.ok(entry, "the shared confirmation is open");
  return entry;
}

test("empty clear scope never creates a destructive confirmation", async () => {
  assert.equal(await confirmClearSessions(0, "空任务"), false);
  assert.equal(overlayStore.getSnapshot().activeDialog, null);
});

test("clear confirmation states the entire scope, preserves the container and defaults to cancel", async () => {
  const pending = confirmClearSessions(7, "任务「菜单验证」");
  const entry = dialog();
  assert.match(entry.options.description!, /全部 7 个会话.*正在运行.*无法撤销.*任务和工作区会保留/);
  assert.equal(entry.options.actions[0].value, false);
  assert.equal(entry.options.actions[0].autoFocus, true);
  assert.equal(entry.options.actions[1].kind, "danger");
  overlayStore.completeDialog(entry.id, { dismissed: false, action: false });
  assert.equal(await pending, false);
});

test("dismissal never authorizes a menu action; only explicit confirmation does", async () => {
  const options = { title: "删除目录？", description: "保留明确的删除范围。", action: "确认删除" };
  const dismissed = confirmSidebarAction(options);
  overlayStore.completeDialog(dialog().id, { dismissed: true });
  assert.equal(await dismissed, false);
  const accepted = confirmSidebarAction(options);
  overlayStore.completeDialog(dialog().id, { dismissed: false, action: true });
  assert.equal(await accepted, true);
});

test("archive remains non-destructive and team-history cleanup names its narrower scope", async () => {
  const archive = confirmSidebarAction({ title: "归档任务？", description: "保留执行。", action: "归档", danger: false });
  assert.equal(dialog().options.actions[1].kind, "secondary");
  overlayStore.completeDialog(dialog().id, { dismissed: true });
  assert.equal(await archive, false);
  const history = confirmClearSessions(3, "已结束的团队会话", null, "只删除 3 个已结束的成员会话，人工会话和任务保留。");
  assert.match(dialog().options.description!, /只删除 3 个已结束的成员会话/);
  overlayStore.completeDialog(dialog().id, { dismissed: true });
  assert.equal(await history, false);
});
