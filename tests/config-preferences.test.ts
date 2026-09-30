import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import {
  applyStoragePreferences,
  defaultConfig,
  getDefaultModelForProvider,
  getProviderDefaultModels,
  resolveDefaultShell,
  writePreferenceToStorage,
} from "../src/config.js";
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

test("default shell follows the account login shell instead of a hardcoded bash", () => {
  if (process.platform === "win32") {
    assert.equal(resolveDefaultShell(), process.env.COMSPEC || "cmd.exe");
    return;
  }
  const loginShell = os.userInfo().shell;
  if (loginShell) {
    assert.equal(resolveDefaultShell(), loginShell);
    assert.equal(defaultConfig().shell, loginShell);
  } else {
    assert.ok(resolveDefaultShell().length > 0);
  }
});

test("commit CLI and model preferences update live config and restore from storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "commitCli", "codex");
  writePreferenceToStorage(config, storage, "commitModel", "  gpt-5.4-mini  ");

  assert.equal(config.commitCli, "codex");
  assert.equal(config.commitModel, "gpt-5.4-mini");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.commitCli, "codex");
  assert.equal(restored.commitModel, "gpt-5.4-mini");
});

test("system AI CLI and model round-trip independently from API route preferences", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();
  assert.equal(config.systemAiCli, undefined, "old installs continue to use the session CLI");
  writePreferenceToStorage(config, storage, "systemAiCli", "pi");
  writePreferenceToStorage(config, storage, "systemAiModel", "  google/gemini-3  ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.systemAiCli, "pi");
  assert.equal(restored.systemAiModel, "google/gemini-3");
  assert.throws(
    () => writePreferenceToStorage(config, storage, "systemAiCli", "shell-command"),
    /无效系统 AI CLI/,
  );
});

test("commit CLI preference rejects unsupported commands", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "commitCli", "cursor"),
    /无效 commit CLI/,
  );
});

test("removed direct-API preferences are gone and legacy DB rows are ignored", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  // 老实例的库里还留着这两条偏好；升级后必须既不读回 config，也不影响其它偏好。
  storage.setPreference("pref:systemAi", { enabled: true, apiKey: "legacy-secret", baseUrl: "https://old.test", model: "old" });
  storage.setPreference("pref:commitAiSource", "api");
  storage.setPreference("pref:commitCli", "codex");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal("systemAi" in restored, false);
  assert.equal("commitAiSource" in restored, false);
  assert.equal(restored.commitCli, "codex", "其余偏好照常生效");
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
  writePreferenceToStorage(config, storage, "defaultTaskWorktree", false);

  assert.equal(config.defaultProvider, "codex");
  assert.equal(config.defaultSessionKind, "pty");
  assert.equal(config.defaultTaskWorktree, false);

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "codex");
  assert.equal(restored.defaultSessionKind, "pty");
  assert.equal(restored.defaultTaskWorktree, false);
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

test("Grok provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "grok");
  writePreferenceToStorage(config, storage, "defaultGrokModel", "  grok-4.5  ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "grok");
  assert.equal(restored.defaultGrokModel, "grok-4.5");
});

test("Qoder provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "qoder");
  writePreferenceToStorage(config, storage, "defaultQoderModel", " performance ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "qoder");
  assert.equal(restored.defaultQoderModel, "performance");
});

test("Pi provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();
  writePreferenceToStorage(config, storage, "defaultProvider", "pi");
  writePreferenceToStorage(config, storage, "defaultPiModel", " openai/gpt-5.4 ");
  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "pi");
  assert.equal(restored.defaultPiModel, "openai/gpt-5.4");
});

test("Gemini provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  const config = defaultConfig();
  writePreferenceToStorage(config, storage, "defaultProvider", "gemini");
  writePreferenceToStorage(config, storage, "defaultGeminiModel", " gemini-2.5-pro ");
  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "gemini");
  assert.equal(restored.defaultGeminiModel, "gemini-2.5-pro");
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
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultThinkingEffort", "turbo"),
    /无效思考深度/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "inheritEnv", "false"),
    /必须是布尔值/,
  );
});

test("`default` 哨兵不是模型 id：历史配置里读到它当没配", () => {
  // 老设置页允许把目录里的 `default` 项存成默认模型，那会一路传成 `--model default`。
  const config = { ...defaultConfig(), defaultModel: "default", defaultCodexModel: " gpt-5 " };
  assert.deepEqual(getProviderDefaultModels(config), {
    claude: "",
    codex: "gpt-5",
    opencode: "",
    grok: "",
    qoder: "",
    pi: "",
    gemini: "",
  });
  assert.equal(getDefaultModelForProvider(config, "claude"), "", "哨兵不当作模型 id 下发");
});
