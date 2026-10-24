import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");

test("Android directory swipe offers delete only for real non-global workspaces and uses the existing confirmation", () => {
  const chrome = source("android/app/src/main/java/com/wand/app/ui/screens/HomeChrome.kt");
  const actions = chrome.slice(chrome.indexOf("    val directoryActions ="), chrome.indexOf("    val isEmpty =", chrome.indexOf("    val directoryActions =")));
  assert.match(actions, /if \(!group\.synthetic && !group\.isGlobal\) listOf\(\s*HomeRowAction\("delete", "删除", WandIcons\.delete, WandColors\.danger, onDeleteDirectory\)/);
  assert.match(chrome, /HomeSwipeRow\("directory:" \+ group\.id, directoryActions/);
  const screen = source("android/app/src/main/java/com/wand/app/ui/screens/TaskListScreen.kt");
  assert.match(screen, /onDeleteDirectory = \{\s*deleteDirectoryTarget =/);
  assert.match(screen, /deleteDirectoryTarget\?\.let \{ group ->\s*WandDialog\(/);
  assert.match(screen, /state\.deleteDirectory\(group, cascade = true\)/);
  assert.match(screen, /state\.deleteDirectory\(group, cascade = false\)/);
});

test("iOS directory swipe offers destructive delete only for bindable projects and opens confirmation rather than deleting directly", () => {
  const view = source("ios/Wand/WorkspaceListView.swift");
  const actions = view.slice(view.indexOf("    private func directoryRowActions("), view.indexOf("    private func treeDisclosureCaret"));
  assert.match(actions, /if group\.isBindableProject \{\s*actions\.append\(HomeRowAction\(id: "delete", title: "删除", symbol: "trash", tint: Theme\.danger\) \{\s*presentConfirm\(\.deleteWorkspace\(workspace\(from: group\)\)\)/);
  assert.doesNotMatch(actions, /store\.deleteWorkspace/);
  assert.match(view, /actions: directoryRowActions\(group\), enabled: !isSelecting && !creationBusy/);
  assert.match(view, /case \.deleteWorkspace\(let workspace\):\s*try await store\.deleteWorkspace\(workspaceId: workspace\.id\)/);
  assert.match(source("ios/Wand/WorkspaceModels.swift"), /var isBindableProject: Bool \{ !isSynthetic && !isGlobal \}/);
});
