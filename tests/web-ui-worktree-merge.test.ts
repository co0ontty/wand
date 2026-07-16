import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorktreeMergeOpenContext,
  closeWorktreeMergeFromLegacy,
  installWorktreeMergeLegacyAdapter,
  openWorktreeMergeForSession,
} from "../src/web-ui/browser/worktree-merge-adapter.ts";
import { settingsController } from "../src/web-ui/react/settings/controller.ts";

import {
  configureWorktreeMergeRuntime,
  worktreeMergeController,
  worktreeMergeStore,
} from "../src/web-ui/react/worktree-merge/controller.ts";
import { MemoryWorktreeMergeRepository } from "../src/web-ui/react/worktree-merge/memory-repository.ts";
import {
  canConfirmWorktreeMerge,
  inspectionStatusMessage,
  worktreeMergeAvailability,
  worktreeMergeResultMessage,
} from "../src/web-ui/react/worktree-merge/model.ts";
import {
  HttpWorktreeMergeRepository,
  normalizeWorktreeMergeInspection,
  normalizeWorktreeMergeResult,
  WorktreeMergeRepositoryError,
} from "../src/web-ui/react/worktree-merge/repository.ts";
import type {
  WorktreeMergeInspection,
  WorktreeMergeResult,
  WorktreeMergeRuntimeAdapter,
} from "../src/web-ui/react/worktree-merge/types.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function inspection(
  overrides: Partial<WorktreeMergeInspection> = {},
): WorktreeMergeInspection {
  return {
    ok: true,
    sourceBranch: "wand/session-1",
    targetBranch: "main",
    worktreePath: "/tmp/wand-session-1",
    repoRoot: "/workspace/wand",
    hasUncommittedChanges: false,
    aheadCount: 2,
    hasConflicts: false,
    recommendedAction: "merge",
    reason: "",
    commits: [
      { hash: "abcdef123456", shortHash: "abcdef1", subject: "feat: first" },
      { hash: "0123456789ab", shortHash: "0123456", subject: "fix: second" },
    ],
    ...overrides,
  };
}

function mergeResult(
  overrides: Partial<WorktreeMergeResult> = {},
): WorktreeMergeResult {
  return {
    ok: true,
    sourceBranch: "wand/session-1",
    targetBranch: "main",
    repoRoot: "/workspace/wand",
    mergeCommit: "fedcba987654",
    mergedAt: "2026-07-16T10:00:00.000Z",
    cleanupDone: true,
    conflict: false,
    errorCode: "",
    reason: "",
    ...overrides,
  };
}

test("worktree availability blocks invalid, running, merging, and completed contexts", () => {
  assert.deepEqual(worktreeMergeAvailability({ sessionId: "", intent: "merge" }), {
    allowed: false,
    reason: "未找到对应会话。",
  });
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "merge",
    sessionStatus: "running",
  }).reason, /仍在运行/);
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "merge",
    mergeStatus: "merging",
  }).reason, /正在合并/);
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "merge",
  }).reason, /没有可合并/);
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "merge",
    sourceBranch: "wand/session-1",
    worktreePath: "/tmp/worktree",
    mergeStatus: "merged",
    cleanupPending: true,
  }).reason, /重试 worktree 清理/);
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "merge",
    sourceBranch: "wand/session-1",
    worktreePath: "/tmp/worktree",
    mergeStatus: "merged",
  }).reason, /已完成合并和清理/);
});

test("cleanup availability requires a pending compensating cleanup", () => {
  assert.deepEqual(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "cleanup",
    cleanupPending: true,
  }), { allowed: true, reason: "" });
  assert.match(worktreeMergeAvailability({
    sessionId: "session-1",
    intent: "cleanup",
    cleanupPending: false,
  }).reason, /无需补偿清理/);
});

test("merge confirmation is enabled only for a clean mergeable inspection", () => {
  assert.equal(canConfirmWorktreeMerge(inspection()), true);
  assert.equal(canConfirmWorktreeMerge(null), false);
  assert.equal(canConfirmWorktreeMerge(inspection({ ok: false })), false);
  assert.equal(canConfirmWorktreeMerge(inspection({ aheadCount: 0 })), false);
  assert.equal(canConfirmWorktreeMerge(inspection({ recommendedAction: "noop" })), false);
  assert.equal(canConfirmWorktreeMerge(inspection({ hasUncommittedChanges: true })), false);
  assert.equal(canConfirmWorktreeMerge(inspection({ hasConflicts: true })), false);
});

test("worktree messages describe successful, cleanup-pending, and blocked states", () => {
  assert.equal(
    worktreeMergeResultMessage(mergeResult()),
    "已合并到 main 并完成 worktree 清理。",
  );
  assert.equal(
    worktreeMergeResultMessage(mergeResult({ cleanupDone: false })),
    "已合并到 main，但工作树仍待清理。",
  );
  assert.match(inspectionStatusMessage(inspection()), /2 个提交/);
  assert.equal(
    inspectionStatusMessage(inspection({ ok: false, reason: "custom reason" })),
    "custom reason",
  );
  assert.match(
    inspectionStatusMessage(inspection({ ok: false, reason: "", hasUncommittedChanges: true })),
    /未提交改动/,
  );
  assert.match(
    inspectionStatusMessage(inspection({ ok: false, reason: "", hasConflicts: true })),
    /冲突风险/,
  );
  assert.match(
    inspectionStatusMessage(inspection({ ok: false, reason: "", aheadCount: 0 })),
    /没有可合并/,
  );
});

test("HTTP worktree repository preserves check, merge, and cleanup contracts", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const signal = new AbortController().signal;
  const repository = new HttpWorktreeMergeRepository((async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/merge/check")) {
      return json({
        session: { id: "session/a" },
        result: {
          ...inspection(),
          commits: [
            { hash: "abcdef123456", message: "feat: normalized" },
            { invalid: true },
          ],
        },
      });
    }
    if (url.endsWith("/worktree/merge")) {
      return json({ session: { id: "session/a" }, result: mergeResult() });
    }
    if (url.endsWith("/worktree/cleanup")) {
      return json({ session: { id: "session/a" }, ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch);

  const checked = await repository.inspect("session/a", { signal });
  assert.deepEqual(checked.commits, [{
    hash: "abcdef123456",
    shortHash: "abcdef1",
    subject: "feat: normalized",
  }]);
  assert.equal((await repository.merge("session/a")).cleanupDone, true);
  assert.deepEqual(await repository.cleanup("session/a"), { ok: true });

  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ["/api/sessions/session%2Fa/worktree/merge/check", "POST"],
    ["/api/sessions/session%2Fa/worktree/merge", "POST"],
    ["/api/sessions/session%2Fa/worktree/cleanup", "POST"],
  ]);
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.signal, signal);
  assert.deepEqual(calls[1].init.headers, { "Content-Type": "application/json" });
  assert.equal(calls[1].init.body, "{}");
  assert.equal(calls[2].init.credentials, "same-origin");
});

test("HTTP worktree repository normalizes safe defaults", () => {
  assert.deepEqual(normalizeWorktreeMergeInspection({
    ok: true,
    aheadCount: -3,
    recommendedAction: "unknown",
    commits: [{ hash: "123456789", subject: 42 }],
  }), {
    ok: true,
    sourceBranch: "",
    targetBranch: "",
    worktreePath: "",
    repoRoot: "",
    hasUncommittedChanges: false,
    aheadCount: 0,
    hasConflicts: false,
    recommendedAction: "merge",
    reason: "",
    commits: [{ hash: "123456789", shortHash: "1234567", subject: "" }],
  });
  assert.deepEqual(normalizeWorktreeMergeResult({ cleanupDone: false, conflict: true }), {
    ok: false,
    sourceBranch: "",
    targetBranch: "",
    repoRoot: "",
    mergeCommit: "",
    mergedAt: "",
    cleanupDone: false,
    conflict: true,
    errorCode: "",
    reason: "",
  });
});

test("HTTP worktree repository surfaces status, code, and partial merge result", async () => {
  const repository = new HttpWorktreeMergeRepository((async () => json({
    error: "合并提交已创建，但清理失败。",
    errorCode: "WORKTREE_CLEANUP_FAILED",
    result: mergeResult({ cleanupDone: false, reason: "permission denied" }),
  }, 409)) as typeof fetch);

  await assert.rejects(
    () => repository.merge("session-1"),
    (error: unknown) => {
      assert.ok(error instanceof WorktreeMergeRepositoryError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "WORKTREE_CLEANUP_FAILED");
      assert.equal(error.result?.cleanupDone, false);
      assert.equal(error.result?.mergeCommit, "fedcba987654");
      return true;
    },
  );
});

test("HTTP worktree repository rejects missing or malformed payloads", async () => {
  const missingResult = new HttpWorktreeMergeRepository((async () => json({ ok: true })) as typeof fetch);
  await assert.rejects(() => missingResult.inspect("session-1"), /未返回合并检查结果/);
  await assert.rejects(() => missingResult.merge("session-1"), /未返回 worktree 合并结果/);

  const malformed = new HttpWorktreeMergeRepository((async () => (
    new Response("not-json", { status: 500 })
  )) as typeof fetch);
  await assert.rejects(
    () => malformed.cleanup("session-1"),
    (error: unknown) => error instanceof WorktreeMergeRepositoryError && error.status === 500,
  );
});

test("memory worktree repository clones values, records calls, errors, and aborts", async () => {
  const repository = new MemoryWorktreeMergeRepository({
    inspection: inspection(),
    mergeResult: mergeResult(),
    cleanupResult: { ok: true },
  });
  const loaded = await repository.inspect("session-1");
  (loaded.commits as Array<{ subject: string }>)[0].subject = "mutated";
  assert.equal(repository.seed.inspection.commits[0].subject, "feat: first");
  await repository.merge("session-1");
  await repository.cleanup("session-1");
  assert.deepEqual(repository.calls, [
    { operation: "inspect", sessionId: "session-1" },
    { operation: "merge", sessionId: "session-1" },
    { operation: "cleanup", sessionId: "session-1" },
  ]);

  repository.seed.errors = { cleanup: new Error("cleanup denied") };
  await assert.rejects(() => repository.cleanup("session-1"), /cleanup denied/);

  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => repository.inspect("session-1", { signal: abort.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("worktree controller owns one contextual lifecycle with an optional runtime seam", () => {
  worktreeMergeController.closeIfOpen();
  assert.equal(worktreeMergeController.open({ sessionId: "  standalone  ", intent: "merge" }), true);
  assert.equal(worktreeMergeStore.getSnapshot().context?.sessionId, "standalone");
  worktreeMergeController.setDismissable(false);
  assert.equal(worktreeMergeController.closeIfOpen(), false);
  assert.equal(worktreeMergeController.closeTopmost(), true);
  assert.equal(worktreeMergeController.isOpen(), true);
  worktreeMergeController.setDismissable(true);
  assert.equal(worktreeMergeController.closeTopmost(), true);
  assert.equal(worktreeMergeController.open({ sessionId: "   ", intent: "merge" }), false);

  const events: string[] = [];
  const runtime: WorktreeMergeRuntimeAdapter = {
    onOpen(context) { events.push(`open:${context.intent}:${context.sessionId}`); },
    onClose(context) { events.push(`close:${context.intent}:${context.sessionId}`); },
    onRepositoryChanged(sessionId) { events.push(`changed:${sessionId}`); },
    toast(message, tone) { events.push(`${tone}:${message}`); },
  };
  const uninstall = configureWorktreeMergeRuntime(runtime);
  const revisions: number[] = [];
  const unsubscribe = worktreeMergeStore.subscribe(() => {
    revisions.push(worktreeMergeStore.getSnapshot().revision);
  });

  assert.equal(worktreeMergeController.open({
    sessionId: " session-1 ",
    intent: "cleanup",
    cleanupPending: true,
  }), true);
  worktreeMergeStore.getRuntime()?.onRepositoryChanged("session-1");
  worktreeMergeStore.getRuntime()?.toast("done", "success");
  assert.equal(worktreeMergeController.closeIfOpen(), true);
  assert.equal(worktreeMergeController.closeIfOpen(), false);
  assert.deepEqual(events, [
    "open:cleanup:session-1",
    "changed:session-1",
    "success:done",
    "close:cleanup:session-1",
  ]);
  assert.equal(revisions.length, 2);

  unsubscribe();
  uninstall();
});

test("legacy adapter maps current session fields into one React open context", () => {
  assert.deepEqual(buildWorktreeMergeOpenContext({
    id: " session-1 ",
    status: "stopped",
    worktree: { branch: " wand/session-1 ", path: " /tmp/session-1 " },
    worktreeMergeStatus: "ready",
    worktreeMergeInfo: { targetBranch: " main ", cleanupDone: true },
  }), {
    sessionId: "session-1",
    intent: "merge",
    sourceBranch: "wand/session-1",
    worktreePath: "/tmp/session-1",
    targetBranch: "main",
    sessionStatus: "stopped",
    mergeStatus: "ready",
    cleanupPending: false,
  });

  assert.deepEqual(buildWorktreeMergeOpenContext({
    id: "legacy",
    status: "exited",
    worktreeBranch: "wand/legacy",
    worktreePath: "/tmp/legacy",
    worktreeMergeStatus: "unknown",
  }), {
    sessionId: "legacy",
    intent: "merge",
    sourceBranch: "wand/legacy",
    worktreePath: "/tmp/legacy",
    sessionStatus: "exited",
    cleanupPending: false,
  });
  assert.equal(buildWorktreeMergeOpenContext({ id: " " }), null);
  assert.equal(buildWorktreeMergeOpenContext(null), null);
});

test("legacy adapter infers pending cleanup while honoring an explicit intent", () => {
  const session = {
    id: "session-1",
    worktree: { branch: "wand/session-1", path: "/tmp/session-1" },
    worktreeMergeStatus: "merged",
    worktreeMergeInfo: { targetBranch: "main", cleanupDone: false },
  };
  assert.deepEqual(buildWorktreeMergeOpenContext(session), {
    sessionId: "session-1",
    intent: "cleanup",
    sourceBranch: "wand/session-1",
    worktreePath: "/tmp/session-1",
    targetBranch: "main",
    mergeStatus: "merged",
    cleanupPending: true,
  });
  assert.equal(buildWorktreeMergeOpenContext(session, "merge")?.intent, "merge");
});

test("legacy adapter owns install, open, toast, refresh, overlay, and close behavior", async () => {
  worktreeMergeController.closeIfOpen();
  settingsController.open("about");
  const events: string[] = [];
  const sessions = new Map([
    ["session-1", {
      id: "session-1",
      status: "stopped",
      worktree: { branch: "wand/session-1", path: "/tmp/session-1" },
      worktreeMergeStatus: "ready",
      worktreeMergeInfo: { targetBranch: "main", cleanupDone: true },
    }],
  ]);
  const dependencies = {
    getSession(sessionId: string) { return sessions.get(sessionId); },
    refreshSessions(sessionId: string) { events.push(`refresh:${sessionId}`); },
    toast(message: string, tone: "success" | "error" | "info") {
      events.push(`${tone}:${message}`);
    },
    onOpen(context: { sessionId: string }) { events.push(`open:${context.sessionId}`); },
    onClose(context: { sessionId: string }) { events.push(`close:${context.sessionId}`); },
  };
  const dispose = installWorktreeMergeLegacyAdapter(dependencies);
  assert.equal(installWorktreeMergeLegacyAdapter(dependencies), dispose);

  assert.equal(openWorktreeMergeForSession("missing"), false);
  assert.equal(openWorktreeMergeForSession(" session-1 "), true);
  assert.equal(settingsController.isOpen(), false);
  assert.equal(worktreeMergeStore.getSnapshot().context?.targetBranch, "main");
  worktreeMergeStore.getRuntime()?.toast("merged", "success");
  worktreeMergeStore.getRuntime()?.onRepositoryChanged("session-1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeWorktreeMergeFromLegacy(), true);
  assert.equal(closeWorktreeMergeFromLegacy(), false);
  assert.deepEqual(events, [
    "error:未找到可操作的 worktree 会话。",
    "open:session-1",
    "success:merged",
    "refresh:session-1",
    "close:session-1",
  ]);

  dispose();
  dispose();
  assert.equal(openWorktreeMergeForSession("session-1"), false);
});

test("legacy adapter converts synchronous and asynchronous refresh failures to toasts", async () => {
  const events: string[] = [];
  const base = {
    getSession: () => null,
    toast(message: string, tone: "success" | "error" | "info") {
      events.push(`${tone}:${message}`);
    },
  };
  const disposeSync = installWorktreeMergeLegacyAdapter({
    ...base,
    refreshSessions() { throw new Error("sync denied"); },
  });
  worktreeMergeStore.getRuntime()?.onRepositoryChanged("sync");
  disposeSync();

  const disposeAsync = installWorktreeMergeLegacyAdapter({
    ...base,
    async refreshSessions() { throw new Error("async denied"); },
  });
  worktreeMergeStore.getRuntime()?.onRepositoryChanged("async");
  await new Promise<void>((resolve) => setImmediate(resolve));
  disposeAsync();

  assert.deepEqual(events, [
    "error:Worktree 已更新，但会话列表刷新失败：sync denied",
    "error:Worktree 已更新，但会话列表刷新失败：async denied",
  ]);
});

test("Worktree dialog styles are React-owned while sidebar badges stay legacy-owned", () => {
  const host = readFileSync(
    new URL("../src/web-ui/react/worktree-merge/host.tsx", import.meta.url),
    "utf8",
  );
  const reactStyles = readFileSync(
    new URL("../src/web-ui/react/styles/features.ts", import.meta.url),
    "utf8",
  );
  const legacyStyles = readFileSync(
    new URL("../src/web-ui/content/styles.css", import.meta.url),
    "utf8",
  );

  for (const selector of [
    ".wand-worktree-dialog",
    ".wand-worktree-header",
    ".wand-worktree-row",
    ".wand-worktree-status",
    ".wand-worktree-actions",
  ]) {
    assert.ok(reactStyles.includes(selector), `React styles must own ${selector}`);
  }
  for (const selector of [
    ".worktree-merge-modal",
    ".worktree-merge-content",
    ".worktree-merge-row",
    ".worktree-merge-actions",
  ]) {
    assert.ok(!legacyStyles.includes(selector), `legacy styles must delete ${selector}`);
  }
  assert.ok(legacyStyles.includes(".session-kind-badge.worktree-merge"));
  assert.ok(!host.includes('className="worktree-merge'));
});

test("browser Worktree adapter stays behind narrow React and callback seams", () => {
  const adapter = readFileSync(
    new URL("../src/web-ui/browser/worktree-merge-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!adapter.includes('from "./state"'));
  assert.ok(!adapter.includes('from "./session-engine"'));
  assert.ok(!adapter.includes('from "./notifications"'));
  assert.ok(!adapter.includes("document."));
  assert.ok(!adapter.includes("fetch("));
});

test("worktree host delegates focus, Escape, and focus restoration to the dialog surface", () => {
  const host = readFileSync(
    new URL("../src/web-ui/react/worktree-merge/host.tsx", import.meta.url),
    "utf8",
  );
  assert.match(host, /<WandDialogSurface/);
  assert.match(host, /onOpenChange=/);
  assert.match(host, /dismissable=\{!submitting\}/);
  assert.match(host, /cancelButton\.current\?\.focus\(\)/);
  assert.ok(!host.includes("document."));
  assert.ok(!host.includes("fetch("));
});
