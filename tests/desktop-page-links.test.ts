import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAGE_ROUTE_KEYS, shareablePageUrl } from "../src/web-ui/page-route.js";

test("Mac and Web share the same credential-free page link parameter vocabulary", () => {
  const source = readFileSync(new URL("../macos/Wand/DesktopPageLink.swift", import.meta.url), "utf8");
  const keys = source.match(/static let keys: Set<String> = \[([\s\S]*?)\]/)?.[1];
  assert.ok(keys);
  const nativeKeys = Array.from(keys.matchAll(/"([^"]+)"/g), match => match[1]);
  assert.deepEqual(nativeKeys.sort(), [...PAGE_ROUTE_KEYS].sort());
  assert.match(source, /components\.user = nil/);
  assert.match(source, /components\.password = nil/);
  assert.match(source, /components\.fragment = nil/);
});

test("page links exclude preferences that now belong to local state", () => {
  const localKeys = ["sidebarMode", "display", "zoom", "hideCompleted", "queue", "expandedTask", "boardCollapsed", "scheduleExpanded"];
  const params = new URLSearchParams({ view: "taskboard", task: "stable-id", q: "shared filter" });
  for (const key of localKeys) params.set(key, "local-value");
  const copied = new URL(shareablePageUrl(`https://wand.test/?${params}`));
  for (const key of localKeys) assert.equal(copied.searchParams.has(key), false, key);
  assert.equal(copied.searchParams.get("task"), "stable-id");
  assert.equal(copied.searchParams.get("q"), "shared filter");
});

test("links preserve Unicode, path filters, commas in labels and stable entity IDs", () => {
  const params = new URLSearchParams({ view: "taskboard", task: "stable-id", q: "URL & 刷新", directory: "stable-workspace",
    filters: JSON.stringify({ statuses: ["doing"], priorities: ["high"], labels: ["a,b", "界面"] }), boardView: "list", sort: "due" });
  const copied = new URL(shareablePageUrl(`https://user:secret@wand.test/?${params}&token=secret&ticket=secret#secret`));
  assert.equal(copied.searchParams.get("q"), "URL & 刷新");
  assert.deepEqual(JSON.parse(copied.searchParams.get("filters")!), { statuses: ["doing"], priorities: ["high"], labels: ["a,b", "界面"] });
  assert.equal(copied.searchParams.get("task"), "stable-id");
  assert.equal(copied.searchParams.get("directory"), "stable-workspace");
  assert.equal(copied.searchParams.get("sort"), "due");
  assert.equal(copied.username, ""); assert.equal(copied.password, ""); assert.equal(copied.hash, "");
  assert.equal(copied.searchParams.has("token"), false); assert.equal(copied.searchParams.has("ticket"), false);
});
