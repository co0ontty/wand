import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyStoragePreferences, defaultConfig, isPreferenceKey, writePreferenceToStorage } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import {
  DEFAULT_USER_DISPLAY_NAME,
  USER_AVATAR_MAX_CHARS,
  USER_PROFILE_NAME_MAX,
  normalizeUserProfile,
  parseUserProfile,
  userAuthor,
  userDisplayName,
} from "../src/user-profile.js";
import type { WandConfig } from "../src/types.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function withStorage(run: (storage: WandStorage, config: WandConfig) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-user-profile-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  try { run(storage, defaultConfig()); }
  finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
}

test("the profile preference lives in DB only and reloads into the runtime config", () => {
  withStorage((storage, config) => {
    assert.equal(isPreferenceKey("userProfile"), true, "这是设置面板可改的偏好键");
    assert.equal(config.userProfile, undefined);
    writePreferenceToStorage(config, storage, "userProfile", { name: "赛博虎妞", avatar: "cat:3" });
    // 真源是 app_config，不是 config.json。
    assert.deepEqual(storage.getPreference<unknown>("pref:userProfile"), { name: "赛博虎妞", avatar: "cat:3" });
    const reloaded = applyStoragePreferences(defaultConfig(), storage);
    assert.deepEqual(reloaded.userProfile, { name: "赛博虎妞", avatar: "cat:3" });
  });
});

test("clearing the profile stores null and the next load falls back to the default name", () => {
  withStorage((storage, config) => {
    writePreferenceToStorage(config, storage, "userProfile", { name: "临时名字" });
    writePreferenceToStorage(config, storage, "userProfile", null);
    assert.equal(storage.hasPreference("pref:userProfile"), false);
    assert.equal(applyStoragePreferences(defaultConfig(), storage).userProfile, undefined);
    assert.equal(config.userProfile, undefined);
  });
});

test("write validation rejects oversized names and bad avatar payloads instead of silently storing them", () => {
  withStorage((storage, config) => {
    assert.throws(() => writePreferenceToStorage(config, storage, "userProfile",
      { name: "x".repeat(USER_PROFILE_NAME_MAX + 1) }), /不能超过/);
    assert.throws(() => writePreferenceToStorage(config, storage, "userProfile", { name: "换行\n名字" }), /换行/);
    assert.throws(() => writePreferenceToStorage(config, storage, "userProfile", { avatar: "https://example.com/a.png" }), /格式无效/);
    assert.throws(() => writePreferenceToStorage(config, storage, "userProfile", { avatar: "data:image/gif;base64,R0lGOD" }), /格式无效/);
    assert.throws(() => writePreferenceToStorage(config, storage, "userProfile",
      { avatar: `data:image/png;base64,${"A".repeat(USER_AVATAR_MAX_CHARS)}` }), /太大/);
    // 一条都没落库：脏值不污染既有配置。
    assert.equal(storage.hasPreference("pref:userProfile"), false);
    assert.equal(config.userProfile, undefined);
  });
});

test("read normalization drops bad values instead of failing the whole config load", () => {
  assert.deepEqual(normalizeUserProfile({ name: "  名字  ", avatar: " cat:2 " }), { name: "名字", avatar: "cat:2" });
  assert.equal(normalizeUserProfile({ name: "   " }), undefined);
  assert.equal(normalizeUserProfile({ avatar: "javascript:alert(1)" }), undefined);
  assert.deepEqual(normalizeUserProfile({ name: "名字", avatar: "https://example.com/a.png" }), { name: "名字" });
  assert.equal(normalizeUserProfile(null), undefined);
  assert.equal(normalizeUserProfile("名字"), undefined);
});

test("the sender projection always resolves to a stable id with one default name", () => {
  assert.deepEqual(userAuthor(undefined), { id: "user", name: DEFAULT_USER_DISPLAY_NAME });
  assert.deepEqual(userAuthor({}), { id: "user", name: DEFAULT_USER_DISPLAY_NAME });
  assert.deepEqual(userAuthor({ name: "虎妞" }), { id: "user", name: "虎妞" });
  // 回合跟着 relay 快照和会话详情一起传：头像留给客户端从 /api/config 取，
  // 否则每条自己发的消息都要带一份几十 KB 的 data URL。
  assert.deepEqual(userAuthor({ name: "虎妞", avatar: PNG }), { id: "user", name: "虎妞" });
  assert.equal(userDisplayName({ name: "  " }), DEFAULT_USER_DISPLAY_NAME);
  // 展示身份不牵涉执行身份：没有 provider / sessionId 之类字段。
  assert.deepEqual(Object.keys(userAuthor({ name: "虎妞" })).sort(), ["id", "name"]);
});

test("parse and normalize agree on the values they accept", () => {
  assert.deepEqual(parseUserProfile({ name: " 虎妞 ", avatar: " cat:1 " }), { name: "虎妞", avatar: "cat:1" });
  assert.deepEqual(parseUserProfile({ name: "虎妞", avatar: PNG }), { name: "虎妞", avatar: PNG });
  assert.equal(parseUserProfile({ name: "", avatar: "" }), undefined);
  assert.deepEqual(parseUserProfile(undefined), undefined);
});