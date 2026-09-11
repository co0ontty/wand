import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { issuesRepository } from "../src/web-ui/react/issues/repository.ts";

test("issue mutations stay bound to loadedRepo even after owner/repo inputs change", () => {
  const text = readFileSync(new URL("../src/web-ui/react/issues/host.tsx", import.meta.url), "utf8");
  assert.match(text, /const \[loadedRepo, setLoadedRepo\]/);
  assert.match(text, /loadGenerationRef/);
  assert.match(text, /createGenerationRef/);
  assert.match(text, /setCreating\(true\)/);
  assert.match(text, /if \(!loadedRepo \|\| !title\.trim\(\) \|\| creating\) return;/);
  assert.match(text, /issuesRepository\.create\(target\.owner, target\.repo/);
  assert.match(text, /issuesRepository\.update\(target\.owner, target\.repo, issue\.number/);
  assert.match(text, /issuesRepository\.bind\(target\.owner, target\.repo, issue\.number/);
  assert.doesNotMatch(text, /loadedRepo \?\? \{ owner: owner\.trim\(\)/);
  assert.doesNotMatch(text, /issuesRepository\.(create|update|bind)\(\s*owner\.trim\(\)/);
  assert.match(text, /if \(generation !== loadGenerationRef\.current\) return;/);
  assert.match(text, /if \(generation !== createGenerationRef\.current\) return;/);
});

test("issues repository encodes owner and repo into mutation URLs", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET" });
    return new Response(JSON.stringify({ number: 12, title: "ok", state: "open", bindings: [] }), {
      status: init?.method === "POST" ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await issuesRepository.update("owner-a", "repo-a", 12, "closed");
    await issuesRepository.bind("owner-a", "repo-a", 12, "session-1");
    await issuesRepository.create("owner-a", "repo-a", "title", "body");
    assert.deepEqual(calls.map((call) => call.url), [
      "/api/github/repos/owner-a/repo-a/issues/12",
      "/api/github/repos/owner-a/repo-a/issues/12/bindings",
      "/api/github/repos/owner-a/repo-a/issues",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
