import assert from "node:assert/strict";
import test from "node:test";

import {
  configureNewSessionRuntime,
  newSessionController,
  newSessionStore,
} from "../src/web-ui/react/new-session/controller.ts";
import {
  buildCreateRequest,
  HttpNewSessionRepository,
  safeMode,
  supportedModes,
} from "../src/web-ui/react/new-session/repository.ts";
import { nextChoice } from "../src/web-ui/react/new-session/choice-navigation.ts";
import type {
  NewSessionCreateRequest,
  NewSessionRuntimeAdapter,
} from "../src/web-ui/react/new-session/types.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("provider modes are clamped without leaking unsupported values", () => {
  assert.deepEqual(supportedModes("codex"), ["full-access"]);
  assert.deepEqual(supportedModes("opencode"), ["default", "full-access", "managed"]);
  assert.deepEqual(supportedModes("grok"), ["default", "full-access", "managed"]);
  assert.equal(safeMode("codex", "native", "default"), "full-access");
  assert.equal(safeMode("opencode", "auto-edit", "managed"), "managed");
  assert.equal(safeMode("claude", "native"), "native");
});

test("radio-card navigation wraps and skips values omitted by the caller", () => {
  const providers = ["claude", "codex", "opencode", "grok"] as const;
  assert.equal(nextChoice(providers, "claude", "ArrowLeft"), "grok");
  assert.equal(nextChoice(providers, "opencode", "ArrowRight"), "grok");
  assert.equal(nextChoice(providers, "codex", "ArrowUp"), "claude");
  assert.equal(nextChoice(providers, "codex", "ArrowDown"), "opencode");
  assert.equal(nextChoice(providers, "codex", "Home"), "claude");
  assert.equal(nextChoice(providers, "codex", "End"), "grok");
  assert.equal(nextChoice(["full-access"] as const, "full-access", "ArrowRight"), "full-access");
});

test("create-request builder preserves structured and PTY legacy contracts", () => {
  const config = {
    defaultProvider: "claude" as const,
    defaultSessionKind: "structured" as const,
    defaultMode: "managed" as const,
    defaultCwd: "/configured",
    structuredRunner: "sdk",
  };
  const context = {
    effectiveCwd: "/effective",
    selectedModels: { claude: "claude-sonnet", codex: "gpt-5" },
    thinkingEffort: "deep",
  };

  assert.deepEqual(buildCreateRequest({
    provider: "claude",
    kind: "structured",
    cwd: "",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context), {
    provider: "claude",
    kind: "structured",
    cwd: "/effective",
    mode: "managed",
    worktreeEnabled: false,
    sessionSource: "interactive",
    runner: "claude-sdk",
    model: "claude-sonnet",
    thinkingEffort: "deep",
  });

  assert.deepEqual(buildCreateRequest({
    provider: "codex",
    kind: "pty",
    cwd: "/repo",
    mode: "native",
    worktreeEnabled: false,
  }, config, context, { cols: 98, rows: 31 }), {
    provider: "codex",
    kind: "pty",
    command: "codex",
    cwd: "/repo",
    mode: "full-access",
    worktreeEnabled: false,
    sessionSource: "interactive",
    cols: 98,
    rows: 31,
  });

  assert.equal(buildCreateRequest({
    provider: "grok",
    kind: "structured",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context).runner, "grok-cli-headless");
});

test("HTTP repository serializes preferences and loads the latest server defaults", async () => {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let preferenceWrites = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === "/api/settings/config") {
      preferenceWrites += 1;
      if (preferenceWrites === 1) await firstWriteGate;
      return json({ ok: true });
    }
    if (url === "/api/config") {
      return json({
        defaultProvider: "opencode",
        defaultSessionKind: "pty",
        defaultMode: "managed",
        defaultCwd: "/repo",
        structuredRunner: "cli",
      });
    }
    if (url === "/api/recent-paths") return json([{ path: "/repo", name: "repo" }]);
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  const repository = new HttpNewSessionRepository(fetchImpl);

  const first = repository.savePreferences({ defaultProvider: "codex" });
  const second = repository.savePreferences({ defaultMode: "full-access" });
  const loading = repository.load();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.url), ["/api/settings/config"]);
  releaseFirstWrite?.();
  await Promise.all([first, second]);
  const loaded = await loading;

  assert.deepEqual(calls.map((call) => call.url), [
    "/api/settings/config",
    "/api/settings/config",
    "/api/config",
    "/api/recent-paths",
  ]);
  assert.equal(loaded.config.defaultProvider, "opencode");
  assert.equal(loaded.config.defaultSessionKind, "pty");
  assert.deepEqual(loaded.recentPaths, [{ path: "/repo", name: "repo" }]);
});

test("HTTP repository selects the endpoint and surfaces server creation errors", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    if (url === "/api/structured-sessions") return json({ id: "structured-1", sessionKind: "structured" }, 201);
    return json({ error: "cwd 不存在" }, 400);
  }) as typeof fetch;
  const repository = new HttpNewSessionRepository(fetchImpl);
  const structured: NewSessionCreateRequest = {
    kind: "structured",
    provider: "opencode",
    cwd: "/repo",
    mode: "managed",
    runner: "opencode-cli-run",
    worktreeEnabled: false,
    sessionSource: "interactive",
  };
  const created = await repository.create(structured);
  assert.equal(created.id, "structured-1");
  assert.equal(calls[0].url, "/api/structured-sessions");
  assert.equal(calls[0].body.runner, "opencode-cli-run");

  await assert.rejects(() => repository.create({
    kind: "pty",
    provider: "claude",
    command: "claude",
    cwd: "/missing",
    mode: "default",
    worktreeEnabled: false,
    sessionSource: "interactive",
  }), /cwd 不存在/);
  assert.equal(calls[1].url, "/api/commands");
});

test("controller delegates lifecycle through one runtime adapter", () => {
  const lifecycle: string[] = [];
  const runtime: NewSessionRuntimeAdapter = {
    onOpen() { lifecycle.push("open"); },
    onClose() { lifecycle.push("close"); },
    getContext() { return { effectiveCwd: "/repo" }; },
    async prepareCreate() { return {}; },
    async completeCreate() {},
  };
  const uninstall = configureNewSessionRuntime(runtime);
  const revisions: number[] = [];
  const unsubscribe = newSessionStore.subscribe(() => {
    revisions.push(newSessionStore.getSnapshot().revision);
  });

  assert.equal(newSessionController.open(), true);
  assert.equal(newSessionController.isOpen(), true);
  newSessionController.setDismissable(false);
  assert.equal(newSessionStore.getSnapshot().dismissable, false);
  assert.equal(newSessionController.closeIfOpen(), false);
  assert.equal(newSessionController.closeTopmost(), true);
  assert.equal(newSessionController.isOpen(), true);
  assert.deepEqual(lifecycle, ["open"]);
  newSessionController.setDismissable(true);
  assert.equal(newSessionController.closeTopmost(), true);
  assert.equal(newSessionController.closeIfOpen(), false);
  assert.deepEqual(lifecycle, ["open", "close"]);
  assert.equal(revisions.length, 4);
  assert.equal(revisions[1], revisions[0], "busy state must not replay open initialization");
  assert.equal(revisions[2], revisions[0], "restoring dismissal must keep the lifecycle revision");

  unsubscribe();
  uninstall();
  assert.equal(newSessionController.open(), false);
});
