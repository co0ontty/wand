import assert from "node:assert/strict";
import test from "node:test";
import { sidebarWorkspaceLabel } from "../src/web-ui/react/workspaces/sidebar-task-meta.js";

const group = { workspaceId: "w", workspaceName: "wand", workspaceCwd: "/Users/me/Self/wand" };

test("person task metadata uses a compact workspace name, not an execution path", () => {
  assert.equal(sidebarWorkspaceLabel(group), "wand");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceName: "  产品工作区  " }), "产品工作区");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceName: "/Users/me/Self/wand/" }), "wand");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceName: "C:\\work\\wand\\" }), "wand");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceName: " " }), "wand");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceName: "", workspaceCwd: "/" }), "");
  assert.equal(sidebarWorkspaceLabel({ ...group, global: true }), "");
  assert.equal(sidebarWorkspaceLabel({ ...group, workspaceId: "wand-global" }), "");
});
