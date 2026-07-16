import assert from "node:assert/strict";
import test from "node:test";

import { applyStoragePreferences, defaultConfig, writePreferenceToStorage } from "../src/config.js";
import type { WandStorage } from "../src/storage.js";

class FakePreferenceStorage {
  private readonly values = new Map<string, unknown>();

  getPreference<T>(key: string, fallback: T): T {
    return this.values.has(key) ? this.values.get(key) as T : fallback;
  }

  setPreference<T>(key: string, value: T): void {
    this.values.set(key, value);
  }

  hasPreference(key: string): boolean {
    return this.values.has(key);
  }
}

test("commit CLI and model preferences update live config and restore from storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "commitCli", "codex");
  writePreferenceToStorage(config, storage, "commitModel", "  gpt-5.4-mini  ");
  writePreferenceToStorage(config, storage, "systemAi", {
    enabled: false,
    protocol: "openai",
    baseUrl: "https://api.example.test/v1",
    apiKey: "direct-secret",
    model: "direct-model",
  });
  writePreferenceToStorage(config, storage, "commitAiSource", "api");

  assert.equal(config.commitCli, "codex");
  assert.equal(config.commitModel, "gpt-5.4-mini");
  assert.equal(config.commitAiSource, "api");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.commitCli, "codex");
  assert.equal(restored.commitModel, "gpt-5.4-mini");
  assert.equal(restored.commitAiSource, "api");
});

test("commit CLI preference rejects unsupported commands", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "commitCli", "cursor"),
    /无效 commit CLI/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "commitAiSource", "automatic"),
    /无效 commit AI 来源/,
  );
});

test("commit direct API preferences reject incomplete and non-object profiles", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  assert.throws(
    () => writePreferenceToStorage(config, storage, "commitAiSource", "api"),
    /必须先填写 API 地址、API Key 和模型/,
  );
  assert.throws(
    () => writePreferenceToStorage(config, storage, "systemAi", "not-an-object"),
    /systemAi 必须是对象/,
  );
});

test("Codex dynamic reasoning effort preference round-trips through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultThinkingEffort", "codex:ultra");

  assert.equal(config.defaultThinkingEffort, "codex:ultra");
  assert.equal(applyStoragePreferences(defaultConfig(), storage).defaultThinkingEffort, "codex:ultra");
});

test("new-session provider and kind preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "codex");
  writePreferenceToStorage(config, storage, "defaultSessionKind", "pty");

  assert.equal(config.defaultProvider, "codex");
  assert.equal(config.defaultSessionKind, "pty");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "codex");
  assert.equal(restored.defaultSessionKind, "pty");
});

test("OpenCode provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "opencode");
  writePreferenceToStorage(config, storage, "defaultOpenCodeModel", "  anthropic/claude-sonnet-4-6  ");
  writePreferenceToStorage(config, storage, "commitCli", "opencode");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "opencode");
  assert.equal(restored.defaultOpenCodeModel, "anthropic/claude-sonnet-4-6");
  assert.equal(restored.commitCli, "opencode");
});

test("new-session preferences reject unsupported values", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;

  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultProvider", "cursor"),
    /无效 Provider/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultSessionKind", "terminal"),
    /无效会话类型/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "structuredRunner", "unknown"),
    /无效 structured runner/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultThinkingEffort", "turbo"),
    /无效思考深度/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "inheritEnv", "false"),
    /必须是布尔值/,
  );
});
