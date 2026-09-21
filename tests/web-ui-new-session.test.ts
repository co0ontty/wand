import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.deepEqual(supportedModes("qoder"), ["default", "full-access", "auto-edit", "managed"]);
  assert.equal(safeMode("codex", "native", "default"), "full-access");
  assert.equal(safeMode("opencode", "auto-edit", "managed"), "managed");
  assert.equal(safeMode("claude", "native"), "native");
});

test("general new-session dialog does not expose worktree creation", () => {
  const source = readFileSync(new URL("../src/web-ui/react/new-session/host.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Worktree 模式|启用 Worktree 模式|wand-new-session-worktree/);
});

test("new-session runtime adapter forwards every provider model preference", () => {
  const source = readFileSync(new URL("../src/web-ui/browser/new-session-adapter.ts", import.meta.url), "utf8");
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi"]) {
    assert.match(source, new RegExp(`${provider}: getChatModelForProvider\\("${provider}"\\)`));
  }
});

test("radio-card navigation wraps and skips values omitted by the caller", () => {
  const providers = ["claude", "codex", "opencode", "grok", "qoder"] as const;
  assert.equal(nextChoice(providers, "claude", "ArrowLeft"), "qoder");
  assert.equal(nextChoice(providers, "opencode", "ArrowRight"), "grok");
  assert.equal(nextChoice(providers, "codex", "ArrowUp"), "claude");
  assert.equal(nextChoice(providers, "codex", "ArrowDown"), "opencode");
  assert.equal(nextChoice(providers, "codex", "Home"), "claude");
  assert.equal(nextChoice(providers, "codex", "End"), "qoder");
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
    selectedModels: {
      claude: "claude-sonnet",
      codex: "gpt-5",
      qoder: "lite",
      pi: "xai/grok-4.6",
    },
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
    // PTY 也照该 provider 用过的模型启动 CLI（macOS 客户端同样如此）。
    model: "gpt-5",
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

  assert.equal(buildCreateRequest({
    provider: "qoder",
    kind: "structured",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context).runner, "qoder-cli-print");
  assert.equal(buildCreateRequest({
    provider: "qoder",
    kind: "structured",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context).model, "lite");

  assert.equal(buildCreateRequest({
    provider: "pi",
    kind: "structured",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context).runner, "pi-cli-json");
  assert.equal(buildCreateRequest({
    provider: "pi",
    kind: "structured",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: false,
  }, config, context).model, "xai/grok-4.6");

  assert.equal(buildCreateRequest({
    provider: "pi",
    kind: "pty",
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: false,
  }, config, context).command, "pi");

  assert.equal(buildCreateRequest({
    provider: "qoder",
    kind: "pty",
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: false,
  }, config, context).command, "qodercli");

  assert.deepEqual(buildCreateRequest({
    provider: "claude",
    kind: "shell",
    cwd: "/repo",
    mode: "managed",
    worktreeEnabled: true,
  }, config, context, { cols: 101, rows: 32 }), {
    kind: "shell",
    shell: true,
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: true,
    sessionSource: "interactive",
    cols: 101,
    rows: 32,
  });
});

test("模型选择随创建请求发出，PTY 也按模型启动 CLI", () => {
  const config = {
    defaultProvider: "claude" as const,
    defaultSessionKind: "structured" as const,
    defaultMode: "default" as const,
    defaultCwd: "/configured",
    structuredRunner: "claude-cli-print",
  };
  const context = {
    effectiveCwd: "/repo",
    selectedModels: { claude: "claude-sonnet", codex: "gpt-5" },
  };
  const base = { cwd: "/repo", mode: "default" as const, worktreeEnabled: false };

  // 对话框里选定的模型优先于 composer 记忆。
  assert.equal(buildCreateRequest(
    { ...base, provider: "claude", kind: "structured", model: "opus" }, config, context,
  ).model, "opus");
  // 没碰过模型字段时沿用该 provider 上次用过的模型。
  assert.equal(buildCreateRequest(
    { ...base, provider: "claude", kind: "structured", model: "" }, config, context,
  ).model, "claude-sonnet");
  // PTY 会话同样带模型（服务端 processCommandForMode 注入 --model）。
  assert.equal(buildCreateRequest(
    { ...base, provider: "codex", kind: "pty", model: "gpt-5" }, config, context,
  ).model, "gpt-5");
  assert.equal(buildCreateRequest(
    { ...base, provider: "codex", kind: "pty", model: "" }, config, context,
  ).model, "gpt-5");
  // 空白终端没有模型概念。
  assert.equal("model" in buildCreateRequest({ ...base, provider: "claude", kind: "shell" }, config, context), false);
});

test("PTY 创建请求把模型发到 /api/commands", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return json({ id: "pty-1" }, 201);
  }) as typeof fetch;
  const repository = new HttpNewSessionRepository(fetchImpl);
  await repository.create({
    kind: "pty",
    provider: "claude",
    command: "claude",
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: false,
    sessionSource: "interactive",
    model: "opus",
  });
  assert.equal(calls[0].url, "/api/commands");
  assert.equal(calls[0].body.model, "opus");
  // 空白终端没有模型概念，不能把 stale 值带上。
  calls.length = 0;
  await repository.create({
    kind: "shell",
    shell: true,
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: false,
    sessionSource: "interactive",
  });
  assert.equal(calls[0].body.model, undefined);
});

test("新建会话对话框提供模型字段并把选择写回 provider 记忆", () => {
  const host = readFileSync(new URL("../src/web-ui/react/new-session/host.tsx", import.meta.url), "utf8");
  assert.match(host, /wand-new-session-model-select/);
  assert.match(host, /rememberModel\(/);
  assert.match(host, /wandModelOptions\(modelCatalog/);

  const adapter = readFileSync(new URL("../src/web-ui/browser/new-session-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /rememberModel\(provider, model\)[\s\S]*setChatModelForProvider\(provider, model \|\| ""\)/);
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

  calls.length = 0;
  const configOnly = await repository.loadConfig();
  assert.equal(configOnly.defaultProvider, "opencode");
  assert.deepEqual(calls.map((call) => call.url), ["/api/config"]);
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

test("HTTP repository creates a bare shell without sending a provider command", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    return json({ id: "shell-1", sessionKind: "pty", command: "/bin/zsh" }, 201);
  }) as typeof fetch;
  const repository = new HttpNewSessionRepository(fetchImpl);

  const created = await repository.create({
    kind: "shell",
    shell: true,
    cwd: "/repo",
    mode: "default",
    worktreeEnabled: false,
    sessionSource: "interactive",
    cols: 100,
    rows: 30,
  });

  assert.equal(created.id, "shell-1");
  assert.equal(calls[0].url, "/api/commands");
  assert.equal(calls[0].body.shell, true);
  assert.equal("command" in calls[0].body, false);
  assert.equal("provider" in calls[0].body, false);
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

  assert.equal(newSessionController.open({ initialCwd: " /workspace/project " }), true);
  assert.equal(newSessionController.isOpen(), true);
  assert.equal(newSessionStore.getSnapshot().initialCwd, "/workspace/project");
  newSessionController.setDismissable(false);
  assert.equal(newSessionStore.getSnapshot().dismissable, false);
  assert.equal(newSessionController.closeIfOpen(), false);
  assert.equal(newSessionController.closeTopmost(), true);
  assert.equal(newSessionController.isOpen(), true);
  assert.deepEqual(lifecycle, ["open"]);
  newSessionController.setDismissable(true);
  assert.equal(newSessionController.closeTopmost(), true);
  assert.equal(newSessionController.closeIfOpen(), false);
  assert.equal(newSessionStore.getSnapshot().initialCwd, "");
  assert.deepEqual(lifecycle, ["open", "close"]);
  assert.equal(revisions.length, 4);
  assert.equal(revisions[1], revisions[0], "busy state must not replay open initialization");
  assert.equal(revisions[2], revisions[0], "restoring dismissal must keep the lifecycle revision");

  unsubscribe();
  uninstall();
  assert.equal(newSessionController.open(), false);
});
