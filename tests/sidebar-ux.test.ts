import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarRowMenu } from "../src/web-ui/react/workspaces/sidebar-row-menu.js";
import { SidebarChevron } from "../src/web-ui/react/workspaces/sidebar-disclosure.js";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

test("最近会话的会话行与目录树共用同一批右键动作", () => {
  const recent = readFileSync(
    new URL("../src/web-ui/react/workspaces/sidebar-recent-section.tsx", import.meta.url), "utf8",
  );
  const panel = readFileSync(
    new URL("../src/web-ui/react/workspaces/workspaces-panel.tsx", import.meta.url), "utf8",
  );
  const confirm = readFileSync(
    new URL("../src/web-ui/react/workspaces/session-delete-confirm.ts", import.meta.url), "utf8",
  );
  const sessionMenu = readFileSync(new URL("../src/web-ui/react/workspaces/sidebar-session-menu.tsx", import.meta.url), "utf8");
  // 两个视图调用同一组件，而不是各自维护一张菜单。
  assert.match(recent, /<SidebarSessionMenu/);
  assert.match(panel, /<SidebarSessionMenu row=\{row\}/);
  assert.match(sessionMenu, /label: "打开会话"/);
  assert.match(sessionMenu, /label: "移动到任务"/);
  assert.match(sessionMenu, /archived \? "恢复会话" : "归档会话"/);
  assert.match(sessionMenu, /confirmSessionDelete\(label\)/);
  assert.doesNotMatch(recent, /wandOverlay\.dialog/);
  assert.match(confirm, /无法撤销。任务和其他会话保留/);
  assert.match(confirm, /kind: "danger"/);
  assert.match(confirm, /answer\.dismissed !== true && Boolean\(answer\.action\)/);
  // 归档 / 删除仍走原有服务端入口，不新增旁路。
  assert.match(panel, /batchArchiveSessions\(\[sessionId\], archived\)/);
  assert.match(panel, /await removeSessions\(\[session\.id\], owner\)/);
});

test("row context menu adds no action button and exposes keyboard/touch affordances", () => {
  const html = renderToStaticMarkup(createElement(SidebarRowMenu, {
    open: false, onOpenChange() {}, label: "测试会话操作", row: createElement("button", null, "测试会话"),
    menu: { items: [{ key: "delete", label: "删除会话", danger: true }] },
  }));
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /Shift\+F10/);
  assert.doesNotMatch(html, /删除会话/);
});

test("sidebar disclosure uses the same down-chevron instance for both states", () => {
  for (const open of [false, true]) {
    const html = renderToStaticMarkup(createElement(SidebarChevron, { open }));
    assert.match(html, new RegExp(`data-open="${open}"`));
    assert.equal((html.match(/<svg\b/g) ?? []).length, 1);
    assert.match(html, /data-wand-icon="chevronDown"/);
  }
});

test("workspace search includes archived sessions without mutating the source ownership", () => {
  const group: TaskDirectoryGroup = {
    workspaceId: "w1", workspaceName: "工程", workspaceCwd: "/work/project", standaloneSessions: [],
    archivedSessions: [{ id: "loose-archive", title: "独立旧记录", archived: true }],
    tasks: [{ id: "t1", workspaceId: "w1", name: "任务", cwd: "/work/project", status: "active",
      worktree: null, layout: null, isolated: false, createdAt: "", lastOpenedAt: null,
      sessions: [{ id: "live", title: "当前会话" }], archivedSessions: [{ id: "old", title: "早期设计方案", archived: true }] }],
  };
  const before = structuredClone(group);
  assert.deepEqual(filterSidebarGroups([group], "早期设计")[0].tasks.map(task => task.id), ["t1"]);
  const archived = filterSidebarGroups([group], "独立旧记录");
  assert.equal(archived[0].tasks.length, 0);
  assert.equal(archived[0].archivedSessions?.[0].id, "loose-archive");
  assert.deepEqual(group, before);
  assert.equal(filterSidebarGroups([{ ...group, global: true, tasks: [] }], "独立旧记录").length, 1);
});
