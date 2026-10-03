import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

import { defaultConfig } from "../src/config.js";
import { ProcessManager } from "../src/process-manager.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { SessionCompletionTracker } from "../src/session-completion.js";
import { createSessionCompletionViewIntent, isSessionJustCompleted, mergeSessionCompletionState } from "../src/session-completion-state.js";
import { SessionRegistry } from "../src/session-registry.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ProcessEvent, SessionSnapshot } from "../src/types.js";
import { filterActiveGroups, isSessionActive, isSessionRunning } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { deriveLegacyUiSnapshot } from "../src/web-ui/react/shell/legacy-snapshot.js";
import { splitTeamSessions } from "../src/web-ui/react/workspaces/team-sessions.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

function snapshot(id = "finished", kind: "structured" | "pty" = "structured"): SessionSnapshot {
  return { id, provider: "pi", sessionKind: kind, runner: kind === "structured" ? "pi-cli-json" : "pty",
    command: "pi", cwd: "/tmp", mode: "assist", status: "idle", exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
    output: "", messages: [], archived: false, archivedAt: null, claudeSessionId: null,
    ...(kind === "structured" ? { structuredState: {
      runner: "pi-cli-json", lastError: null, inFlight: false, activeRequestId: null,
    } } : {}),
  };
}

test("automatic selection and background refresh cannot consume explicit completion viewing", () => {
  const view = createSessionCompletionViewIntent();
  assert.equal(view.isOpen("automatic-newest"), false);
  view.open("clicked-A");
  assert.equal(view.isOpen("clicked-A"), true);
  assert.equal(view.isOpen("automatic-newest"), false);
  view.open("clicked-B");
  assert.equal(view.isOpen("clicked-A"), false, "late A rendering cannot consume a result after switching to B");
  assert.equal(view.isOpen("clicked-B"), true);
  view.clear();
  assert.equal(view.isOpen("clicked-B"), false, "going home terminates the view intent");
});

test("completion generations persist without backfilling history or accepting stale checkpoints", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-completion-"));
  const db = join(root, "wand.db");
  let storage = new WandStorage(db);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const saved = snapshot();
  storage.saveSession(saved);
  assert.equal(isSessionJustCompleted(storage.getSession(saved.id)!), false);
  const before = storage.tasksAggregateFingerprint();
  assert.deepEqual(storage.recordSessionCompletion(saved.id), { completionRevision: 1, viewedCompletionRevision: 0 });
  assert.notEqual(storage.tasksAggregateFingerprint(), before);
  assert.equal(isSessionJustCompleted(storage.getSessionSlim(saved.id)!), true);
  const checkpoint = { ...storage.getSession(saved.id)! };
  assert.equal(storage.markSessionCompletionViewed(saved.id, 1), true);
  assert.equal(storage.markSessionCompletionViewed(saved.id, 1), false);
  storage.saveSession(checkpoint);
  storage.updateSessionRuntimeMetadata({ ...checkpoint, completionRevision: 99, viewedCompletionRevision: 0 });
  storage.checkpointSessionMessages(saved.id, []);
  assert.deepEqual(storage.getSessionCompletion(saved.id), { completionRevision: 1, viewedCompletionRevision: 1 });
  storage.recordSessionCompletion(saved.id);
  assert.equal(storage.markSessionCompletionViewed(saved.id, 1), false, "old view cannot consume the new result");
  storage.close();
  storage = new WandStorage(db);
  assert.deepEqual(storage.getSessionCompletion(saved.id), { completionRevision: 2, viewedCompletionRevision: 1 });
  assert.equal(isSessionJustCompleted(storage.loadSessionsSlim()[0]), true);
  storage.deleteSession(saved.id);
  assert.equal(storage.recordSessionCompletion(saved.id), null, "a late completion cannot recreate a deleted session");
});

test("completion tracker observes actual success boundaries, not reads, errors or stops", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-completion-tracker-"));
  const storage = new WandStorage(join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  let live = snapshot();
  storage.saveSession(live);
  const tracker = new SessionCompletionTracker(storage, () => live);
  const emit = (type: ProcessEvent["type"], data: Record<string, unknown>) => {
    const event: ProcessEvent = { type, sessionId: live.id, data };
    tracker.ingest(event);
    return data;
  };
  emit("output", { ...live });
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 0);
  assert.equal(emit("ended", { ...live }).completionRevision, 1);
  emit("ended", { ...live });
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 1, "duplicate end is idempotent");
  for (const status of ["failed", "stopped", "running"] as const) {
    live = { ...live, status, exitCode: status === "failed" ? 1 : null };
    emit("ended", { ...live });
  }
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 1);

  live = { ...snapshot("terminal", "pty"), status: "running", providerCliActive: true, exitCode: null };
  storage.saveSession(live);
  emit("status", { ptyBusy: false });
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 0, "restored idle PTY is not newly completed");
  live.ptyBusy = true;
  emit("status", { ptyBusy: true });
  live.ptyBusy = false;
  assert.equal(emit("status", { ptyBusy: false }).completionRevision, 1);
  emit("status", { ptyBusy: false });
  emit("status", { providerCliActive: false, providerCliExitCode: 0 });
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 1, "CLI exit must not duplicate its finished turn");
  live.ptyBusy = true;
  emit("status", { ptyBusy: true });
  live = { ...live, ptyBusy: false, providerCliExitCode: 130 };
  emit("status", { ptyBusy: false, providerCliActive: false, providerCliExitCode: 130 });
  assert.equal(storage.getSessionCompletion(live.id)?.completionRevision, 1, "interrupted CLI is not successful");

  live = { ...snapshot("shell", "pty"), provider: undefined, status: "exited" };
  storage.saveSession(live);
  assert.equal(emit("ended", { ...live }).completionRevision, 1, "successful raw terminal completion");
});

test("just completed stays in the activity filter without inflating running counts", () => {
  const unread = { ...snapshot(), completionRevision: 2, viewedCompletionRevision: 1 };
  assert.equal(isSessionJustCompleted(unread), true);
  assert.equal(isSessionActive(unread), true);
  assert.equal(isSessionRunning(unread), false);
  const shell = deriveLegacyUiSnapshot({ selectedId: unread.id, sessions: [unread] }, {
    width: 1280, online: true, embedTerminal: false, nativeInput: false, backToNative: false, switchServer: false,
  });
  assert.equal(shell.topbar.statusLabel, "刚完成");
  assert.equal(shell.topbar.statusTone, "just-completed");
  const step = { ...unread, teamStep: { runId: "run", stepId: "step", kind: "work", title: "done",
    memberId: "member", memberName: "成员", teamName: "团队", stepStatus: "done", runStatus: "done", runFinished: true } };
  assert.equal(splitTeamSessions([step]).live.length, 1, "unread team completion must not disappear into history");
  assert.equal(splitTeamSessions([{ ...step, viewedCompletionRevision: 2 }]).history.length, 1);
  for (const changed of [
    { viewedCompletionRevision: 2 }, { archived: true }, { ptyBusy: true },
    { inFlight: true }, { permissionBlocked: true }, { status: "failed" }, { status: "stopped" },
    { providerCliExitCode: 1 },
  ]) assert.equal(isSessionJustCompleted({ ...unread, ...changed }), false);
  const groups: TaskDirectoryGroup[] = [{ workspaceId: "workspace", workspaceName: "Wand",
    workspaceCwd: "/tmp", tasks: [], standaloneSessions: [unread, { id: "seen", status: "idle" }] }];
  assert.deepEqual(filterActiveGroups(groups)[0].standaloneSessions.map((entry) => entry.id), [unread.id]);
  assert.deepEqual(mergeSessionCompletionState(
    { completionRevision: 3, viewedCompletionRevision: 2 },
    { completionRevision: 2, viewedCompletionRevision: 2 },
  ), { completionRevision: 3, viewedCompletionRevision: 2 });
});

test("only explicit generation-checked viewing consumes completion and invalidates both list revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-completion-routes-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const structured = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry(processes, structured, storage);
  const app = express();
  app.use(express.json());
  const events: ProcessEvent[] = [];
  registerSessionRoutes(app, processes, structured, storage, config.defaultMode, config, sessions,
    undefined, (event) => events.push(event));
  registerWorkspaceRoutes(app, storage, sessions);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const workspace = storage.createWorkspace({ name: "Wand", cwd: root });
    const row = { ...snapshot(), cwd: root, workspaceId: workspace.id };
    storage.saveSession(row);
    storage.recordSessionCompletion(row.id);
    const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
    const page = await get("/api/session-list");
    const taskPage = await get("/api/tasks?revision=initial");
    await get(`/api/sessions/${row.id}?format=chat`);
    await get(`/api/sessions/${row.id}/messages`);
    await get("/api/sessions");
    assert.equal(sessions.get(row.id)?.viewedCompletionRevision, 0);
    assert.equal(page.entries[0].session.completionRevision, 1);
    assert.equal(taskPage.groups[0].standaloneSessions[0].completionRevision, 1);
    const view = (completionRevision: unknown, id = row.id) => fetch(`${base}/api/sessions/${id}/completion/view`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completionRevision }),
    });
    for (const invalid of [null, "1", 0, -1, 1.5]) assert.equal((await view(invalid)).status, 400);
    assert.equal((await view(1, "missing")).status, 404);
    const result = await (await view(1)).json() as { viewedCompletionRevision: number };
    assert.equal(result.viewedCompletionRevision, 1);
    assert.equal(sessions.listSlim()[0].viewedCompletionRevision, 1);
    assert.notEqual((await get(`/api/session-list?revision=${page.revision}`)).revision, page.revision);
    assert.equal((await get(`/api/tasks?revision=${taskPage.revision}`)).unchanged, false);
    await view(1);
    assert.equal(events.length, 1, "acknowledgement broadcasts once across devices");
    storage.recordSessionCompletion(row.id);
    await view(1);
    assert.equal(sessions.get(row.id)?.viewedCompletionRevision, 1);
    assert.equal(isSessionJustCompleted(sessions.get(row.id)!), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose(); structured.dispose(); storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
