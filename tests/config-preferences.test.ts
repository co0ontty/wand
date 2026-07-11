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

  assert.equal(config.commitCli, "codex");
  assert.equal(config.commitModel, "gpt-5.4-mini");

  const restored = applyStoragePreferences(defaultConfig(), storage);
  assert.equal(restored.commitCli, "codex");
  assert.equal(restored.commitModel, "gpt-5.4-mini");
});

test("commit CLI preference rejects unsupported commands", () => {
  const storage = new FakePreferenceStorage() as unknown as WandStorage;
  assert.throws(
    () => writePreferenceToStorage(defaultConfig(), storage, "commitCli", "cursor"),
    /无效 commit CLI/,
  );
});
