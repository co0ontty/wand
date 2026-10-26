import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDirectoryGroup, TaskSummary, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";
import { loadReactModule } from "./helpers/react-startup-harness.js";

test("workspace group hiding preserves task guards and clears only listed sessions", async () => {
  const ordinary = { id: "ordinary", title: "visible work", provider: "codex", status: "idle" } as WorkspaceSessionSummary;
  const hidden = { id: "hidden", title: "hidden group", provider: "codex", status: "thinking",
    inFlight: true, teamChat: { teamId: "team", runId: "run", teamName: "hidden group", memberCount: 2 } } as WorkspaceSessionSummary;
  const task = { id: "task", workspaceId: "workspace", name: "task", cwd: "/workspace", sessions: [ordinary, hidden] } as TaskSummary;
  const group: TaskDirectoryGroup = { workspaceId: "workspace", workspaceName: "workspace", workspaceCwd: "/workspace", tasks: [task], standaloneSessions: [] };
  const before = JSON.stringify(group);
  const menus: Array<{ items: Array<{ key: string; label?: string; disabled?: boolean }>; onClick(event: unknown): void }> = [];
  const clears: Array<{ ids: readonly string[]; task: TaskSummary | null }> = [];
  const { api } = loadReactModule("src/web-ui/react/workspaces/workspaces-panel.tsx", {
    "./task-groups-store": { useTaskGroups: () => ({ groups: [group], loading: false, error: "", reload: async () => {} }) },
    "../use-page-route": { usePageRouteState: (_key: string, initial: unknown) => [initial, () => {}], routeEnum: () => undefined },
    "../agents/employee-repository": { useSiliconEmployees: () => ({ employees: [] }) },
    "./sidebar-row-menu": { SidebarRowMenu: ({ menu, children }: { menu: typeof menus[number]; children: ReactNode }) => {
      menus.push(menu); return createElement(Fragment, null, children);
    } },
    "./sidebar-menu-confirm": { confirmClearSessions: async () => true, confirmSidebarAction: async () => true },
    "./sidebar-session-actions": { deleteSidebarSessions: async (ids: readonly string[], source: TaskSummary | null) => { clears.push({ ids, task: source }); } },
  });
  const html = renderToStaticMarkup(createElement(api.WorkspacesPanel));
  assert.doesNotMatch(html, /hidden group/);
  assert.match(html, /visible work/);
  const menu = menus.find(candidate => candidate.items.some(item => item.key === "archive"));
  assert.ok(menu, "real task menu rendered");
  assert.equal(menu.items.find(item => item.key === "archive")?.disabled, true, "hidden executing session still blocks task archive");
  assert.equal(menu.items.find(item => item.key === "clear")?.label, "清空所列会话（1）");
  menu.onClick({ key: "clear", domEvent: { stopPropagation() {} } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clears.length, 1);
  assert.deepEqual(Array.from(clears[0].ids), ["ordinary"]);
  assert.equal(clears[0].task, task, "mutation owner retains the complete source task");
  assert.equal(JSON.stringify(group), before, "stored tasks and hidden groups stay intact");
});
