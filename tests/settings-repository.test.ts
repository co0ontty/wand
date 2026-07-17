import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { MemorySettingsRepository } from "../src/web-ui/react/settings/memory-repository.ts";
import {
  HttpSettingsRepository,
  type SettingsRuntimeAdapter,
} from "../src/web-ui/react/settings/repository.ts";
import type {
  SettingsConfig,
  SettingsNotificationPreferences,
  SettingsSnapshot,
} from "../src/web-ui/react/settings/types.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWandNative = Object.getOwnPropertyDescriptor(globalThis, "WandNative");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: "127.0.0.1",
    port: 3000,
    https: false,
    defaultMode: "default",
    defaultCwd: "/tmp",
    shell: "/bin/zsh",
    language: "zh-CN",
    structuredRunner: "cli",
    inheritEnv: true,
    defaultModel: "claude-sonnet",
    defaultCodexModel: "gpt-5",
    defaultOpenCodeModel: "openai/gpt-5",
    defaultGrokModel: "grok-4.5",
    defaultModels: { claude: "claude-sonnet", codex: "gpt-5", opencode: "openai/gpt-5", grok: "grok-4.5" },
    commitCli: "claude",
    commitModel: "",
    commitAiSource: "cli",
    systemAi: {
      enabled: true,
      protocol: "openai",
      baseUrl: "https://api.example.test",
      apiKey: "server-must-never-leak",
      hasApiKey: true,
      model: "gpt-test",
      authHeader: "bearer",
      source: "custom",
    },
    commandPresets: [],
    cardDefaults: { editCards: false, inlineTools: false, terminal: false, thinking: false, toolGroup: false },
    ...overrides,
  };
}

function adminPayload(): Record<string, unknown> {
  const current = config();
  return {
    settingsAccess: "admin",
    packageName: "@co0ontty/wand",
    version: "4.6.1",
    nodeVersion: ">=22",
    repoUrl: "https://github.com/example/wand",
    updateAvailable: false,
    latestVersion: "4.6.1",
    updateChannel: "stable",
    build: { commit: "abcdef012345", shortCommit: "abcdef0", builtAt: null, channel: "stable" },
    config: current,
    desiredConfig: current,
    activeConfig: current,
    restartRequired: false,
    hasCert: false,
    autoUpdate: { web: false, apk: false, dmg: false, cli: false },
    androidApk: { enabled: false },
    macosDmg: { enabled: false },
  };
}

class RuntimeSpy implements SettingsRuntimeAdapter {
  notifications: SettingsNotificationPreferences[] = [];
  configs: SettingsConfig[] = [];
  notificationPreferencesChanged(preferences: SettingsNotificationPreferences): void { this.notifications.push(preferences); }
  configSaved(value: SettingsConfig): void { this.configs.push(value); }
}

beforeEach(() => {
  const storage = new Map<string, string>();
  const windowValue = {
    location: { origin: "http://127.0.0.1:3000" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    open: () => null,
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: { classList: { contains: () => false } },
      body: { appendChild: () => undefined },
      createElement: () => ({ click: () => undefined, remove: () => undefined }),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0", clipboard: { writeText: async () => undefined } },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of [["window", originalWindow], ["document", originalDocument], ["navigator", originalNavigator], ["WandNative", originalWandNative]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("admin load is settings-first and maps models, CLI updates, and connect code once", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/settings") return json(adminPayload());
    if (url === "/api/models") return json({ models: [{ id: "claude-sonnet", label: "Sonnet" }], codexModels: [], opencodeModels: [], defaultModels: {} });
    if (url === "/api/provider-cli-updates") return json({ items: [{ id: "claude", label: "Claude", installed: true }], checkedAt: null, updating: false, autoUpdate: false });
    if (url.startsWith("/api/app-connect-code")) return json({ code: "connect-secret", url: "http://127.0.0.1:3000" });
    throw new Error(`unexpected request ${url}`);
  };

  const snapshot = await new HttpSettingsRepository(new RuntimeSpy()).load();
  assert.deepEqual(calls, [
    "/api/settings",
    "/api/models",
    "/api/provider-cli-updates",
    "/api/app-connect-code?origin=http%3A%2F%2F127.0.0.1%3A3000",
  ]);
  assert.equal(snapshot.access, "admin");
  assert.equal(snapshot.models?.models[0].id, "claude-sonnet");
  assert.equal(snapshot.providerCliUpdates?.items[0].id, "claude");
  assert.equal(snapshot.connectCode?.code, "connect-secret");
  assert.equal(snapshot.config?.systemAi.apiKey, "", "repository must redact a malicious server secret");
  assert.equal(snapshot.config?.systemAi.hasApiKey, true);
});

test("403 admin response falls back to the public About snapshot", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/settings") return json({ error: "forbidden" }, 403);
    if (url === "/api/settings/about") return json({
      packageName: "@co0ontty/wand",
      version: "4.6.1",
      nodeVersion: ">=22",
      repoUrl: "",
      updateChannel: "stable",
      build: {},
      androidApk: {},
      macosDmg: {},
    });
    throw new Error(`unexpected request ${url}`);
  };
  const snapshot = await new HttpSettingsRepository(new RuntimeSpy()).load();
  assert.deepEqual(calls, ["/api/settings", "/api/settings/about"]);
  assert.equal(snapshot.access, "read-only");
  assert.equal(snapshot.config, null);
});

test("abort and JSON HTTP errors propagate without being converted to read-only", async () => {
  globalThis.fetch = async (_input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    return json({ error: "settings exploded" }, 500);
  };
  const repository = new HttpSettingsRepository(new RuntimeSpy());
  const abort = new AbortController();
  abort.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(repository.load({ signal: abort.signal }), { name: "AbortError" });
  await assert.rejects(repository.load(), /settings exploded/);
});

test("AI save preserves the empty-key sentinel and emits only a redacted runtime config", async () => {
  let submitted: Record<string, unknown> | null = null;
  const runtime = new RuntimeSpy();
  globalThis.fetch = async (_input, init) => {
    submitted = JSON.parse(String(init?.body));
    return json({ ok: true, config: config(), desiredConfig: config(), activeConfig: config(), restartRequired: false });
  };
  const value = {
    defaultModel: "claude-sonnet",
    defaultCodexModel: "gpt-5",
    defaultOpenCodeModel: "openai/gpt-5",
    defaultGrokModel: "grok-4.5",
    commitCli: "claude" as const,
    commitModel: "",
    commitAiSource: "api" as const,
    systemAi: {
      enabled: true,
      protocol: "openai" as const,
      baseUrl: "https://api.example.test",
      apiKey: "",
      hasApiKey: true,
      model: "gpt-test",
      authHeader: "bearer" as const,
      source: "custom" as const,
    },
  };
  await new HttpSettingsRepository(runtime).execute({ type: "ai.save", value });
  assert.equal((submitted?.systemAi as Record<string, unknown>).apiKey, "");
  assert.equal(runtime.configs[0].systemAi.apiKey, "");
  assert.equal(runtime.configs[0].systemAi.hasApiKey, true);
});

test("notification preference commands synchronize the injected runtime adapter", async () => {
  const runtime = new RuntimeSpy();
  const result = await new HttpSettingsRepository(runtime).execute({
    type: "notification.preferences.set",
    value: { sound: false, volume: 35, bubble: false },
  });
  assert.equal(result.sound, false);
  assert.equal(result.volume, 35);
  assert.equal(runtime.notifications.length, 1);
  assert.deepEqual(runtime.notifications[0], result);
});

test("native notification permission resolves through the WebView callback and cleans it up", async () => {
  let permission = "default";
  Object.defineProperty(globalThis, "WandNative", {
    configurable: true,
    value: {
      getPermission: () => permission,
      requestPermission: () => {
        permission = "granted";
        queueMicrotask(() => window._onNativePermissionResult?.("granted"));
      },
    },
  });

  const result = await new HttpSettingsRepository(new RuntimeSpy()).execute({
    type: "notification.permission.request",
  });

  assert.deepEqual(result, { permission: "granted" });
  assert.equal(window._onNativePermissionResult, undefined);
});

test("MemorySettingsRepository records semantic commands without browser side effects", async () => {
  const snapshot = { access: "read-only" } as unknown as SettingsSnapshot;
  const memory = new MemorySettingsRepository(snapshot, (command) => {
    assert.equal(command.type, "clipboard.copy");
    return { copied: true };
  });
  const result = await memory.execute({ type: "clipboard.copy", text: "hello" });
  assert.deepEqual(result, { copied: true });
  assert.deepEqual(memory.commands, [{ type: "clipboard.copy", text: "hello" }]);
});
