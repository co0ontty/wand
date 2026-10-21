import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../macos/Wand/", import.meta.url);
const available = existsSync(root);
const source = (name: string): string => readFileSync(new URL(name + ".swift", root), "utf8");

// Source-level guard only: native interaction coverage still requires the macOS XCTest host.
// SwiftUI can set isPresented=false before invoking the destructive action. Every
// action must use the presenting snapshot, not read optional @State after dismissal.
for (const [file, state, parameter, action, type] of [
  ["WorkspaceListView", "deleteTarget", "target", "confirmDeleteTask", "WorkspaceTask"],
  ["WorkspaceListView", "clearTarget", "target", "confirmClearSessions", "WorkspaceTaskSummary"],
  ["WorkspaceListView", "deleteSessionTarget", "target", "confirmDeleteSession", "WorkspaceSessionSummary"],
  ["WorkspaceListView", "pendingManagedDelete", "selection", "confirmManagedDelete", "TaskListPresentation.ManageSelection"],
  // The shared WorkspaceSessionHeader lives in WorkspaceTaskView.swift.
  ["WorkspaceTaskView", "pendingDelete", "target", "confirmDeleteSession", "WorkspaceSessionSummary"],
] as const) {
  test(`macOS ${file}.${action} carries its target across dialog dismissal`, { skip: !available }, () => {
    const text = source(file);
    assert.match(text, new RegExp(`presenting: ${state}\\s*\\) \\{ ${parameter} in`));
    assert.ok(text.includes(`Task { await ${action}(${parameter}) }`), "Capture data before scheduling the async action");
    assert.match(text, new RegExp(`private func ${action}\\(_ \\w+: ${type.replaceAll(".", "\\.")}\\) async`));
    assert.doesNotMatch(text, new RegExp(`guard let \\w+ = ${state}\\b`), "Dismissed UI state is not an execution payload");
  });
}

test("macOS directory modifier forwards the presenting snapshot, not a state-reading callback", { skip: !available }, () => {
  const text = source("WorkspaceListView");
  assert.match(text, /presenting: deleteWorkspaceTarget\s*\) \{ target in/);
  assert.ok(text.includes("onDeleteWorkspace(target)"));
  assert.ok(text.includes("let onDeleteWorkspace: (TaskDirectoryGroup) -> Void"));
  assert.match(text, /onDeleteWorkspace: \{ target in\s*Task \{ await confirmDeleteWorkspace\(target\) \}/);
  assert.doesNotMatch(text, /guard let \w+ = deleteWorkspaceTarget\b/);
});

test("macOS standalone and legacy deletions use a snapshot without deferred state cleanup", { skip: !available }, () => {
  const text = source("SessionSidebarView");
  assert.match(text, /presenting: pendingDeletion\s*\) \{ target in/);
  assert.ok(text.includes("confirmPendingDeletion(target)"));
  assert.ok(text.includes("private func confirmPendingDeletion(_ target: PendingDeletion)"));
  assert.match(text, /switch target \{\s*case \.sessions\(let sessions\):\s*deleteSessions\(sessions\)\s*case \.history\(let history\):\s*deleteHistory\(history\)/);
  const binding = text.slice(text.indexOf("private var deletionConfirmationPresented"), text.indexOf("private var deletionErrorPresented"));
  assert.match(binding, /if !isPresented \{ pendingDeletion = nil \}/);
  assert.doesNotMatch(binding, /DispatchQueue|asyncAfter/);
});

for (const action of ["deleteWorkspace", "deleteWorkspaceTask"] as const) {
  test(`macOS ${action} commits the delete receipt to the sidebar before refreshing`, { skip: !available }, () => {
    const text = source("WorkspaceStore");
    const start = text.indexOf(`    func ${action}(`, text.indexOf("final class WorkspaceStore"));
    const end = text.indexOf("\n    func ", start + 1);
    const method = text.slice(start, end < 0 ? undefined : end);
    const accepted = method.indexOf(`try await api.${action}(`);
    const invalidate = method.indexOf("invalidateTaskGroupsAfterReceipt()");
    const projection = method.indexOf("taskGroups = taskGroups.");
    const refresh = method.indexOf("startTaskGroupsRefresh(force: true)");
    assert.ok(accepted >= 0 && accepted < invalidate && invalidate < projection && projection < refresh,
      "Only an accepted DELETE removes rows; invalidate stale reads before projecting and refreshing");
    assert.match(method, action === "deleteWorkspace" ? /filter \{ \$0\.workspaceId != workspaceId \}/ : /filter \{ \$0\.id != taskId \}/);
  });
}

test("macOS session batch deletion refreshes and reports partial success instead of a success toast", { skip: !available }, () => {
  const text = source("WorkspaceStore");
  const start = text.indexOf("    func deleteSessions(");
  const method = text.slice(start, text.indexOf("\n    ///", start));
  assert.match(method, /let deleted = try await api\.deleteWorkspaceSessions\(sessionIds: ids\)/);
  assert.ok(method.indexOf("invalidateTaskGroupsAfterReceipt()") < method.indexOf("await loadTaskGroups(force: true)"));
  assert.match(method, /if deleted < ids\.count \{\s*throw NSError/);
  assert.ok(method.indexOf("await loadTaskGroups(force: true)") < method.indexOf("if deleted < ids.count"));
});

test("macOS task terminal deletion failures remain visible after confirmation closes", { skip: !available }, () => {
  const text = source("WorkspaceTaskView");
  assert.match(text, /struct WorkspaceSessionHeader: View/);
  assert.match(text, /\.alert\("删除未完成", isPresented: Binding\(\s*get: \{ deleteError != nil \}/);
  assert.match(text, /catch \{\s*deleteError = error\.localizedDescription/);
  assert.match(text, /Text\(deleteError \?\? ""\)/);
});
