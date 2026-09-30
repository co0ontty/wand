import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WandStorage } from "../src/storage.js";
import { SESSION_PROVIDERS } from "../src/session-provider.js";
import type { SessionSnapshot } from "../src/types.js";
import { fetchProviderUsage } from "../src/web-ui/react/provider-usage-repository.js";
import { sortProviderOptions } from "../src/web-ui/react/provider-usage.js";

function snapshot(id: string, extras: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id, command: "claude", provider: "claude", cwd: "/tmp", mode: "default",
    status: "idle", exitCode: null, startedAt: "2026-07-14T00:00:00Z",
    endedAt: null, output: "", archived: false, archivedAt: null,
    claudeSessionId: null, sessionKind: "pty", ...extras,
  };
}

test("tool counts reflect retained interactive CLI launches, not messages or bare shells", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-provider-usage-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });

  assert.deepEqual(storage.countInteractiveSessionsByProvider(),
    Object.fromEntries(SESSION_PROVIDERS.map((provider) => [provider, 0])));
  storage.saveSession(snapshot("claude-1", { archived: true, messages: [] }));
  storage.saveSession(snapshot("claude-1", { archived: true, messages: [{ role: "user", content: [] }] }));
  storage.saveSession(snapshot("claude-2"));
  storage.saveSession(snapshot("codex-1", { provider: "codex", command: "codex" }));
  storage.saveSession(snapshot("legacy-qoder", { provider: undefined, command: "qodercli" }));
  storage.saveSession(snapshot("legacy-pi", { provider: undefined, runner: "pi-cli-json", command: "" }));
  storage.saveSession(snapshot("shell", { provider: undefined, command: "/bin/zsh" }));
  storage.saveSession(snapshot("automation", { provider: "codex", sessionSource: "automation" }));

  assert.deepEqual(storage.countInteractiveSessionsByProvider(), {
    claude: 2, codex: 1, opencode: 0, grok: 0, qoder: 1, pi: 1, gemini: 0,
  });
  storage.deleteSession("claude-2");
  assert.equal(storage.countInteractiveSessionsByProvider().claude, 1);
});

test("provider choices sort by usage descending, retain tie order and leave shell last", () => {
  const values = ["claude", "codex", "opencode", "grok", "qoder", "pi", "gemini", "shell"];
  const original = values.map((value) => ({ value }));
  assert.deepEqual(sortProviderOptions(original, {}, (entry) => entry.value), original);
  assert.deepEqual(sortProviderOptions(original, {
    pi: 8, codex: 4, claude: 4, grok: 1,
  }, (entry) => entry.value).map((entry) => entry.value), [
    "pi", "claude", "codex", "grok", "opencode", "qoder", "gemini", "shell",
  ]);
  assert.deepEqual(original.map((entry) => entry.value), values, "never reorder the shared constants");
});

test("provider usage fetch validates counts and falls back on request failures", async () => {
  const calls: Array<{ url: string; credentials?: RequestCredentials }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), credentials: init?.credentials });
    return new Response(JSON.stringify({ pi: 9, claude: -1, codex: "10", grok: 2.5, shell: 99 }));
  }) as typeof fetch;
  assert.deepEqual(await fetchProviderUsage(fetchImpl), { pi: 9 });
  assert.deepEqual(calls, [{ url: "/api/sessions/provider-usage", credentials: "same-origin" }]);
  const unavailable = (async () => new Response("", { status: 503 })) as typeof fetch;
  await assert.rejects(() => fetchProviderUsage(unavailable), /HTTP 503/);
});
