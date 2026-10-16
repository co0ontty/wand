import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyStoragePreferences,
  defaultConfig,
  loadConfigWithStorage,
  getDefaultModelForProvider,
  getProviderDefaultModels,
  resolveDefaultShell,
  writePreferenceToStorage,
} from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import type { WandStorage as WandStorageType } from "../src/storage.js";

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

test("deployment trust fields are normalized and survive config storage round-trip", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-deployment-config-"));
  const configPath = path.join(dir, "config.json");
  const storage = new WandStorage(path.join(dir, "wand.db"));
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(configPath, JSON.stringify({
    browserExtensionIds: [" chrome-extension://abc ", null, "", 42, "moz-extension://def"],
    trustProxy: "  loopback, 10.0.0.0/8  ",
  }));

  const loaded = await loadConfigWithStorage(configPath, storage);
  assert.deepEqual(loaded.browserExtensionIds, ["chrome-extension://abc", "moz-extension://def"]);
  assert.equal(loaded.trustProxy, "loopback, 10.0.0.0/8");
  assert.deepEqual((await loadConfigWithStorage(configPath, storage)).browserExtensionIds, loaded.browserExtensionIds);
  assert.equal((await loadConfigWithStorage(configPath, storage)).trustProxy, loaded.trustProxy);

  writeFileSync(configPath, JSON.stringify({ browserExtensionIds: "not-an-array", trustProxy: ["bad"] }));
  const malformed = await loadConfigWithStorage(configPath, storage);
  assert.equal(malformed.browserExtensionIds, undefined);
  assert.equal(malformed.trustProxy, undefined);

  writeFileSync(configPath, JSON.stringify({ browserExtensionIds: ["  ", " chrome-extension://ok ", null], trustProxy: "   " }));
  const partial = await loadConfigWithStorage(configPath, storage);
  assert.deepEqual(partial.browserExtensionIds, ["chrome-extension://ok"]);
  assert.equal(partial.trustProxy, undefined);
});

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

test("temporary cleanup is deployment-owned, defaults on, and only accepts boolean disabling", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-cleanup-config-"));
  const storage = new WandStorage(path.join(dir, "wand.db"));
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const configPath = path.join(dir, "config.json");
  assert.equal(defaultConfig().autoCleanupTemporaryFiles, true);
  for (const [value, expected] of [[false, false], [true, true], ["false", true], [0, true]]) {
    writeFileSync(configPath, JSON.stringify({ autoCleanupTemporaryFiles: value }));
    assert.equal((await loadConfigWithStorage(configPath, storage)).autoCleanupTemporaryFiles, expected);
  }
});

test("commit CLI and model preferences update live config and restore from storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
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
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();
  assert.equal(config.systemAiCli, undefined, "old installs continue to use the session CLI");
  writePreferenceToStorage(config, storage, "systemAiCli", "pi");
  writePreferenceToStorage(config, storage, "systemAiModel", "  openai/gpt-5.4  ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.systemAiCli, "pi");
  assert.equal(restored.systemAiModel, "openai/gpt-5.4");
  assert.throws(
    () => writePreferenceToStorage(config, storage, "systemAiCli", "shell-command"),
    /无效系统 AI CLI/,
  );
});

test("commit CLI preference rejects unsupported commands", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "commitCli", "cursor"),
    /无效 commit CLI/,
  );
});

test("removed direct-API preferences are gone and legacy DB rows are ignored", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
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
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultThinkingEffort", "codex:ultra");

  assert.equal(config.defaultThinkingEffort, "codex:ultra");
  assert.equal(applyStoragePreferences(defaultConfig(), storage).defaultThinkingEffort, "codex:ultra");
});

test("new-session provider and kind preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "codex");
  writePreferenceToStorage(config, storage, "defaultSessionKind", "pty");
  writePreferenceToStorage(config, storage, "defaultEngine", "sdk");
  writePreferenceToStorage(config, storage, "defaultTaskWorktree", false);

  assert.equal(config.defaultProvider, "codex");
  assert.equal(config.defaultSessionKind, "pty");
  assert.equal(config.defaultEngine, "sdk");
  assert.equal(config.defaultTaskWorktree, false);

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "codex");
  assert.equal(restored.defaultSessionKind, "pty");
  assert.equal(restored.defaultEngine, "sdk", "Wand Agent 的选择要能记住，不能下次悄悄回到 Pi CLI");
  assert.equal(restored.defaultTaskWorktree, false);
});

test("OpenCode provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
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
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "grok");
  writePreferenceToStorage(config, storage, "defaultGrokModel", "  grok-4.5  ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "grok");
  assert.equal(restored.defaultGrokModel, "grok-4.5");
});

test("Qoder provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();

  writePreferenceToStorage(config, storage, "defaultProvider", "qoder");
  writePreferenceToStorage(config, storage, "defaultQoderModel", " performance ");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "qoder");
  assert.equal(restored.defaultQoderModel, "performance");
});

test("Pi provider and model preferences round-trip through storage", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();
  writePreferenceToStorage(config, storage, "defaultProvider", "pi");
  writePreferenceToStorage(config, storage, "defaultPiModel", " openai/gpt-5.4 ");
  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "pi");
  assert.equal(restored.defaultPiModel, "openai/gpt-5.4");
});

test("removed provider preferences reject selection and loading without deleting legacy data", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();
  assert.throws(
    () => writePreferenceToStorage(config, storage, "defaultProvider", "gemini"),
    /无效 Provider|unsupported|不支持/i,
  );
  storage.setPreference("pref:defaultProvider", "gemini");
  storage.setPreference("pref:defaultGeminiModel", "legacy-model");
  assert.throws(() => applyStoragePreferences(defaultConfig(), storage), /不支持的执行工具偏好/);
  assert.equal(storage.getPreference("pref:defaultProvider", ""), "gemini");
  writePreferenceToStorage(config, storage, "defaultProvider", "pi");
  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.defaultProvider, "pi");
  assert.equal("defaultGeminiModel" in restored, false);
  assert.equal(storage.getPreference("pref:defaultGeminiModel", ""), "legacy-model");
});

test("legacy removed tool defaults fail before bootstrapping and respect corrected DB preferences", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-removed-tool-config-"));
  const configPath = path.join(dir, "config.json");
  const storage = new WandStorage(path.join(dir, "wand.db"));
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(configPath, JSON.stringify({ defaultProvider: "gemini" }));
  await assert.rejects(loadConfigWithStorage(configPath, storage), /不支持的执行工具偏好/);
  assert.equal(storage.getPreference("pref:defaultProvider", ""), "gemini");
  assert.equal(storage.getSystemSiliconEmployee(), null);
  writePreferenceToStorage(defaultConfig(), storage, "defaultProvider", "pi");
  assert.equal((await loadConfigWithStorage(configPath, storage)).defaultProvider, "pi");
});

test("new-session preferences reject unsupported values", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;

  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultProvider", "cursor"),
    /无效 Provider/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultSessionKind", "terminal"),
    /无效会话类型/,
  );
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "defaultEngine", "core"),
    /无效执行引擎/,
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

test("task retention preference updates live config and rejects partial or out-of-range values", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorageType;
  const config = defaultConfig();
  const value = {
    autoArchiveEnabled: false,
    autoArchiveDays: 3,
    autoDeleteEnabled: true,
    autoDeleteDays: 14,
  };

  writePreferenceToStorage(config, storage, "taskRetention", value);
  assert.deepEqual(config.taskRetention, value);
  assert.deepEqual(applyStoragePreferences(defaultConfig(), storage).taskRetention, value);

  assert.throws(
    () => writePreferenceToStorage(config, storage, "taskRetention", { ...value, autoArchiveDays: 0 }),
    /空闲天数/,
  );
  assert.throws(
    () => writePreferenceToStorage(config, storage, "taskRetention", { autoArchiveEnabled: false }),
    /空闲天数/,
  );
  assert.throws(
    () => writePreferenceToStorage(config, storage, "taskRetention", {
      ...value,
      autoDeleteEnabled: "no",
    }),
    /自动删除开关/,
  );
  assert.deepEqual(config.taskRetention, value, "a rejected write must not replace the live setting");

  storage.setPreference("pref:taskRetention", { autoArchiveEnabled: "no", autoArchiveDays: 2, autoDeleteDays: 9 });
  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.taskRetention?.autoArchiveEnabled, true);
  assert.equal(restored.taskRetention?.autoArchiveDays, 2);
  assert.equal(restored.taskRetention?.autoDeleteEnabled, true);
  assert.equal(restored.taskRetention?.autoDeleteDays, 9);
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
  });
  assert.equal(getDefaultModelForProvider(config, "claude"), "", "哨兵不当作模型 id 下发");
});
