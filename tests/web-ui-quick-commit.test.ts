import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  configureQuickCommitRuntime,
  quickCommitController,
  quickCommitStore,
} from "../src/web-ui/react/quick-commit/controller.ts";
import { MemoryQuickCommitRepository } from "../src/web-ui/react/quick-commit/memory-repository.ts";
import {
  actionFromOptions,
  buildQuickCommitInput,
  buildQuickCommitOutcome,
  normalizeQuickCommitAction,
  quickCommitActionMeta,
  quickCommitStatusBadge,
} from "../src/web-ui/react/quick-commit/model.ts";
import {
  HttpQuickCommitRepository,
  normalizeQuickCommitStatus,
} from "../src/web-ui/react/quick-commit/repository.ts";
import type {
  QuickCommitRuntimeAdapter,
  QuickCommitStatus,
} from "../src/web-ui/react/quick-commit/types.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function status(overrides: Partial<QuickCommitStatus> = {}): QuickCommitStatus {
  return {
    isGit: true,
    branch: "main",
    modifiedCount: 2,
    files: [
      { path: "src/a.ts", status: " M", isSubmodule: false },
      { path: "vendor/lib", status: " M", isSubmodule: true },
    ],
    head: "1234567890",
    ahead: 1,
    behind: 0,
    lastCommit: { hash: "1234567890", shortHash: "1234567", subject: "before" },
    latestTag: "v1.0.0",
    hasSubmodule: true,
    ...overrides,
  };
}

test("legacy quick-commit renderer, listeners, state, and CSS stay deleted", () => {
  const gitCommit = readFileSync(new URL("../src/web-ui/browser/git-commit.ts", import.meta.url), "utf8");
  const events = readFileSync(new URL("../src/web-ui/browser/events.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../src/web-ui/browser/render.ts", import.meta.url), "utf8");
  const stateSource = readFileSync(new URL("../src/web-ui/browser/state.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");

  for (const fragment of [
    "renderQuickCommitModal",
    "attachQuickCommitModalListeners",
    "attachQuickCommitDrag",
    "quickCommitSubmitting",
    "quickCommitResult",
  ]) {
    assert.ok(!gitCommit.includes(fragment), `git-commit.ts must not restore ${fragment}`);
    assert.ok(!events.includes(fragment), `events.ts must not restore ${fragment}`);
    assert.ok(!render.includes(fragment), `render.ts must not restore ${fragment}`);
    assert.ok(!stateSource.includes(fragment), `state.ts must not restore ${fragment}`);
  }
  assert.ok(!styles.includes(".quick-commit-modal"));
  assert.ok(!styles.includes(".qc-dock"));
  assert.ok(!styles.includes(".qc-pair"));
});

test("quick-commit action model produces the four legacy API combinations", () => {
  assert.equal(normalizeQuickCommitAction("unknown"), "commit");
  assert.equal(actionFromOptions(false, false), "commit");
  assert.equal(actionFromOptions(true, false), "commit-tag");
  assert.equal(actionFromOptions(false, true), "commit-push");
  assert.equal(actionFromOptions(true, true), "commit-tag-push");
  assert.deepEqual(quickCommitActionMeta("commit-tag-push"), {
    action: "commit-tag-push",
    label: "Commit + Tag + Push",
    verb: "提交、打 Tag 并推送",
    withTag: true,
    push: true,
  });

  assert.deepEqual(buildQuickCommitInput(
    { message: "  release changes  ", tag: " v1.1.0 ", tagEdited: true },
    "commit-tag-push",
    true,
  ), {
    autoMessage: false,
    customMessage: "release changes",
    tag: "v1.1.0",
    autoTag: false,
    push: true,
    submodule: true,
  });

  assert.deepEqual(buildQuickCommitInput(
    { message: "", tag: "unused", tagEdited: false },
    "commit",
    false,
  ), {
    autoMessage: true,
    customMessage: "",
    tag: "",
    autoTag: false,
    push: false,
    submodule: false,
  });

  assert.deepEqual(buildQuickCommitInput(
    { message: "", tag: "", tagEdited: false },
    "commit-tag",
    false,
  ), {
    autoMessage: true,
    customMessage: "",
    tag: "",
    autoTag: true,
    push: false,
    submodule: false,
  });
});

test("quick-commit model preserves before/after context and porcelain badges", () => {
  const result = buildQuickCommitOutcome(
    "commit-tag",
    true,
    { message: "fallback", tag: "v1.1.0", tagEdited: true },
    status(),
    {
      ok: true,
      commit: { hash: "abcdef123456", message: "generated subject" },
      tag: { name: "v1.1.0" },
      pushed: false,
      pushError: "",
      submoduleCommits: [{ path: "vendor/lib", hash: "9999999" }],
    },
  );
  assert.deepEqual(result, {
    action: "commit-tag",
    includeSubmodule: true,
    pushed: false,
    pushError: "",
    commitHash: "abcdef1",
    commitMessage: "generated subject",
    tagName: "v1.1.0",
    oldTag: "v1.0.0",
    oldCommitHash: "1234567",
    oldCommitSubject: "before",
    submoduleCount: 1,
  });
  assert.deepEqual(quickCommitStatusBadge("??"), {
    letter: "U",
    tone: "untracked",
    label: "未跟踪",
  });
  assert.equal(quickCommitStatusBadge(" M").tone, "modified");
  assert.equal(quickCommitStatusBadge("R.").label, "重命名");
});

test("HTTP quick-commit repository normalizes status and preserves endpoint contracts", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/git-status")) {
      return json({
        isGit: true,
        branch: "feature/test",
        modifiedCount: 2,
        files: [
          { path: "src/a.ts", status: "M." },
          {
            path: "vendor/lib",
            status: " M",
            isSubmodule: true,
            submoduleState: { commitChanged: true, hasTrackedChanges: false, hasUntracked: true },
          },
          { invalid: true },
        ],
        lastCommit: { hash: "abc", shortHash: "abc", subject: "old" },
        latestTag: "v1",
      });
    }
    if (url.endsWith("/generate-commit-message")) {
      return json({ message: "feat: generated", suggestedTag: " v2 " });
    }
    if (url.endsWith("/quick-commit")) {
      return json({
        ok: true,
        commit: { hash: "abcdef123", message: "feat: generated" },
        tag: { name: "v2" },
        pushed: false,
        submoduleCommits: [{ path: "vendor/lib", hash: "123" }],
      });
    }
    if (url.endsWith("/git/push")) {
      return json({ ok: false, pushedCommits: true, pushedTags: false, error: "tag rejected" });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const repository = new HttpQuickCommitRepository(fetchImpl);

  const loaded = await repository.loadStatus("session/a");
  assert.equal(loaded.branch, "feature/test");
  assert.equal(loaded.files.length, 2);
  assert.equal(loaded.hasSubmodule, true);
  assert.deepEqual(loaded.files[1].submoduleState, {
    commitChanged: true,
    hasTrackedChanges: false,
    hasUntracked: true,
  });
  assert.deepEqual(await repository.generate("session/a"), {
    message: "feat: generated",
    suggestedTag: "v2",
  });
  const input = {
    autoMessage: true,
    customMessage: "",
    tag: "",
    autoTag: true,
    push: false,
    submodule: true,
  };
  const committed = await repository.commit("session/a", input);
  assert.equal(committed.commit?.hash, "abcdef123");
  assert.equal(committed.submoduleCommits.length, 1);
  const pushed = await repository.push("session/a", {
    pushCommits: true,
    pushTags: true,
    submodule: true,
    tag: "v2",
  });
  assert.deepEqual(pushed, {
    ok: false,
    pushedCommits: true,
    pushedTags: false,
    error: "tag rejected",
  });

  assert.deepEqual(calls.map((call) => [call.url, call.method]), [
    ["/api/sessions/session%2Fa/git-status", "GET"],
    ["/api/sessions/session%2Fa/generate-commit-message", "POST"],
    ["/api/sessions/session%2Fa/quick-commit", "POST"],
    ["/api/sessions/session%2Fa/git/push", "POST"],
  ]);
  assert.deepEqual(calls[2].body, input);
});

test("HTTP quick-commit repository surfaces server errors and safe status defaults", async () => {
  const normalized = normalizeQuickCommitStatus({ isGit: true, files: [{ path: "a", status: "??" }] });
  assert.equal(normalized.modifiedCount, 1);
  assert.equal(normalized.branch, "");
  assert.equal(normalized.hasSubmodule, false);

  const repository = new HttpQuickCommitRepository((async () => (
    json({ error: "working tree locked" }, 409)
  )) as typeof fetch);
  await assert.rejects(() => repository.commit("session", {
    autoMessage: true,
    customMessage: "",
    tag: "",
    autoTag: false,
    push: false,
    submodule: false,
  }), /working tree locked/);
});

test("Memory quick-commit repository records immutable commands", async () => {
  const repository = new MemoryQuickCommitRepository({
    status: status(),
    suggestion: { message: "generated", suggestedTag: "v2" },
  });
  const loaded = await repository.loadStatus("session-1");
  (loaded.files[0] as { path: string }).path = "mutated";
  assert.equal(repository.seed.status.files[0].path, "src/a.ts");
  assert.deepEqual(await repository.generate("session-1"), {
    message: "generated",
    suggestedTag: "v2",
  });
  await repository.commit("session-1", {
    autoMessage: false,
    customMessage: "subject",
    tag: "",
    autoTag: false,
    push: false,
    submodule: false,
  });
  await repository.push("session-1", {
    pushCommits: true,
    pushTags: false,
    submodule: false,
    tag: "",
  });
  assert.deepEqual(repository.calls.map((call) => call.operation), [
    "loadStatus",
    "generate",
    "commit",
    "push",
  ]);
});

test("quick-commit controller owns one contextual overlay lifecycle", () => {
  quickCommitController.closeIfOpen();
  const events: string[] = [];
  const runtime: QuickCommitRuntimeAdapter = {
    onOpen(context) { events.push(`open:${context.sessionId}`); },
    onClose(context) { events.push(`close:${context.sessionId}`); },
    onRepositoryChanged(sessionId) { events.push(`changed:${sessionId}`); },
    toast(message, tone) { events.push(`${tone}:${message}`); },
  };
  const uninstall = configureQuickCommitRuntime(runtime);
  const revisions: number[] = [];
  const unsubscribe = quickCommitStore.subscribe(() => {
    revisions.push(quickCommitStore.getSnapshot().revision);
  });

  assert.equal(quickCommitController.open({ sessionId: "  session-1  " }), true);
  assert.deepEqual(quickCommitStore.getSnapshot().context, { sessionId: "session-1" });
  quickCommitStore.getRuntime()?.onRepositoryChanged("session-1");
  quickCommitStore.getRuntime()?.toast("done", "success");
  quickCommitController.setDismissable(false);
  assert.equal(quickCommitController.closeIfOpen(), false);
  assert.equal(quickCommitController.closeTopmost(), true);
  assert.equal(quickCommitController.isOpen(), true);
  quickCommitController.setDismissable(true);
  assert.equal(quickCommitController.closeTopmost(), true);
  assert.equal(quickCommitController.closeIfOpen(), false);
  assert.deepEqual(events, [
    "open:session-1",
    "changed:session-1",
    "success:done",
    "close:session-1",
  ]);
  assert.equal(revisions.length, 4);
  assert.equal(revisions[1], revisions[0], "busy state must not replay open initialization");
  assert.equal(revisions[2], revisions[0], "restoring dismissal must keep the lifecycle revision");

  unsubscribe();
  uninstall();
  assert.equal(quickCommitController.open({ sessionId: "session-2" }), false);
});
