import assert from "node:assert/strict";
import test from "node:test";

import {
  getToolDisplayName,
  getToolIcon,
  getToolIconKind,
} from "../src/web-ui/browser/tool-identity.js";

test("tool icon classification handles provider prefixes, MCP namespaces, and casing", () => {
  const cases = new Map<string, string>([
    ["Read", "read"],
    ["Write", "edit"],
    ["Codex/apply_patch", "edit"],
    ["OpenCode/BASH", "terminal"],
    ["node_repl__js", "terminal"],
    ["mcp__github__search_issues", "search"],
    ["mcp__browser__browser_navigate", "web"],
    ["Codex/collaboration.spawn_agent", "agent"],
    ["Codex/send_input", "agent"],
    ["request_user_input", "question"],
    ["view_image", "image"],
    ["update_plan", "todo"],
    ["wait", "wait"],
    ["custom_provider_tool", "generic"],
  ]);

  for (const [name, expected] of cases) {
    assert.equal(getToolIconKind(name), expected, name);
    assert.match(getToolIcon(name), new RegExp(`data-tool-icon="${expected}"`), name);
    assert.notEqual(getToolIcon(name), "·");
  }
});

test("tool display names are case-insensitive and understand namespaced known tools", () => {
  assert.equal(getToolDisplayName("read"), "读取文件");
  assert.equal(getToolDisplayName("Codex/apply_patch"), "应用补丁");
  assert.equal(getToolDisplayName("mcp__server__custom_action"), "mcp__server__custom_action");
  assert.equal(getToolDisplayName(""), "工具");
});
