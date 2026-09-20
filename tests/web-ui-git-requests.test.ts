import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as cache from "../src/web-ui/browser/git-status-cache.js";
import type { QuickCommitRuntimeAdapter, QuickCommitStatus } from "../src/web-ui/react/quick-commit/types.js";

function harness() {
  const state: Record<string, any> = { selectedId: "A" };
  const requests: Array<{ resolve: (response: Response) => void }> = [];
  const noop = () => {};
  const fallback = new Proxy({}, { get: () => noop });
  const api: Record<string, any> = {};
  let runtime: QuickCommitRuntimeAdapter;
  const source = readFileSync(new URL("../src/web-ui/browser/git-commit.ts", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: api,
    require: (id: string) => {
      if (id === "./state") return { state };
      if (id === "./git-status-cache") return cache;
      if (id === "../react/quick-commit/controller") {
        return { configureQuickCommitRuntime: (adapter: QuickCommitRuntimeAdapter) => { runtime = adapter; } };
      }
      return fallback;
    },
    Date: class extends Date { static now() { return 100; } },
    fetch: () => new Promise<Response>((resolve) => requests.push({ resolve })),
  });
  const respond = (index: number, count: number) => requests[index].resolve(new Response(JSON.stringify({ isGit: true, modifiedCount: count })));
  return { state, api, requests, respond, runtime: runtime! };
}

test("forced refresh after a workspace mutation does not reuse an earlier read", async () => {
  const h = harness();
  const older = h.api.loadGitStatus("A");
  const newer = h.api.loadGitStatus("A", { force: true });
  assert.equal(h.requests.length, 2);
  h.respond(1, 5); await newer;
  h.respond(0, 1); await older;
  assert.equal(h.state.gitStatus.modifiedCount, 5, "older response must not undo fresh changes, even in the same millisecond");
});

test("A-B-A switching shares pending reads per session and old completion cannot clear newer work", async () => {
  const h = harness();
  const a = h.api.loadGitStatus("A");
  const b = h.api.loadGitStatus("B");
  assert.equal(h.api.loadGitStatus("A"), a);
  const fresh = h.api.loadGitStatus("A", { force: true });
  h.respond(0, 1); await a;
  h.state.gitStatusLastFetchAt = -10000;
  assert.equal(h.api.loadGitStatus("A"), fresh);
  h.respond(2, 3); await fresh;
  h.respond(1, 8); await b;
  assert.equal(h.state.gitStatus.modifiedCount, 3);
});

test("quick-commit and badge requests share ordering through the runtime adapter", async () => {
  const h = harness();
  const olderBadge = h.api.loadGitStatus("A");
  const panelTime = h.runtime.nextStatusRequestTime();
  h.runtime.onStatusLoaded("A", { isGit: true, modifiedCount: 7 } as QuickCommitStatus, panelTime);
  h.respond(0, 1); await olderBadge;
  assert.equal(h.state.gitStatus.modifiedCount, 7, "an older badge response must not replace the panel snapshot");

  const olderPanelTime = h.runtime.nextStatusRequestTime();
  const newerBadge = h.api.loadGitStatus("A", { force: true });
  h.respond(1, 9); await newerBadge;
  h.runtime.onStatusLoaded("A", { isGit: true, modifiedCount: 2 } as QuickCommitStatus, olderPanelTime);
  assert.equal(h.state.gitStatus.modifiedCount, 9, "an older panel response must not replace the fresh badge snapshot");
});
