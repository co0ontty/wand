import assert from "node:assert/strict";
import test from "node:test";
import { mergePageSearch, shareablePageUrl, unknownPageParameters } from "../src/web-ui/page-route.js";

test("empty, null and oversized values never reach the address bar", () => {
  assert.equal(mergePageSearch("?q=a", { q: "" }), "");
  assert.equal(mergePageSearch("?q=a&sort=x", { q: null }), "?sort=x");
  assert.equal(mergePageSearch("", { q: "x".repeat(257) }), "");
  assert.equal(mergePageSearch("", { q: "x".repeat(256) }).length, 259);
});

test("leaving a page drops its own parameters but keeps workspace selection", () => {
  const board = "?view=taskboard&session=s&q=hello&sort=title&task=t1&filters=%7B%7D";
  assert.equal(mergePageSearch(board, { view: "teams" }), "?view=teams&session=s");
  assert.equal(mergePageSearch("?view=teams&team=a&teamQuery=z", { view: "teams", team: "b" }), "?view=teams&team=b&teamQuery=z");
  assert.equal(mergePageSearch("?view=teams&session=s", { view: "taskboard", directory: "w" }), "?view=taskboard&session=s&directory=w");
  // Same view: nothing is pruned.
  assert.equal(mergePageSearch("?view=taskboard&q=a", { sort: "title" }), "?view=taskboard&q=a&sort=title");
});

test("retired URL state is cleaned on the next write and tolerated in old links", () => {
  assert.equal(mergePageSearch("?view=taskboard&display=%7B%7D&boardCollapsed=%7B%7D&scheduleExpanded=%5B%5D&sidebarMode=rail", { sort: "title" }), "?view=taskboard&sort=title");
  assert.deepEqual(unknownPageParameters("?display=1&sidebarMode=rail&bogus=1"), ["bogus"]);
  assert.equal(shareablePageUrl("https://h/?view=taskboard&display=1&sidebarMode=rail&embed=1#x"), "https://h/?view=taskboard");
});

test("knowledge links preserve scope, employee and document while leaving drops library state", () => {
  const route = "?view=knowledge&knowledgeScope=personal&knowledgeOwner=e_a&knowledgeDocument=k_a";
  assert.deepEqual(unknownPageParameters(route), []);
  assert.equal(shareablePageUrl(`https://h/${route}`), `https://h/${route}`);
  assert.equal(mergePageSearch(route, { view: "workspace" }), "?view=workspace");
});
