import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createServer } from "node:http";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

test("system AI CLI preference runs the chosen model for prompt optimization", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-cli-"));
  const previousPath = process.env.PATH;
  const previousDeepRepairDisable = process.env.WAND_PATH_REPAIR_DEEP_DISABLE;
  const argsPath = path.join(dir, "pi-args.txt");
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const binary = path.join(binDir, "pi");
  writeFileSync(binary, [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > '${argsPath}'`,
    `printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"CLI_OK"}]}}'`,
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  // This test owns the fake CLI at the front of PATH. Login-shell path repair
  // can otherwise put the user's real Pi before it and invoke live credentials.
  process.env.WAND_PATH_REPAIR_DEEP_DISABLE = "1";
  const config = {
    ...defaultConfig(), host: "127.0.0.1", port: 0, https: false,
    password: "test-password", startupCommands: [], defaultProvider: "codex" as const,
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
  };
  let handle: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    handle = await startServer(config, path.join(dir, "config.json"));
    const baseUrl = handle.urls[0]!.url;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const saved = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST", headers,
      body: JSON.stringify({ systemAiCli: "pi", systemAiModel: "google/test" }),
    });
    assert.equal(saved.status, 200);
    assert.equal(config.systemAiCli, "pi");
    assert.equal(config.systemAiModel, "google/test");
    const optimized = await fetch(`${baseUrl}/api/optimize-prompt`, {
      method: "POST", headers, body: JSON.stringify({ text: "fix bug" }),
    });
    assert.equal(optimized.status, 200, await optimized.clone().text());
    assert.deepEqual(await optimized.json(), { optimized: "CLI_OK" });
    const args = readFileSync(argsPath, "utf8").split("\n");
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("google/test"));
    assert.equal(args.includes("codex"), false);

    const invalid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST", headers, body: JSON.stringify({ systemAiCli: "shell-command", systemAiModel: "other" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(config.systemAiCli, "pi");
    assert.equal(config.systemAiModel, "google/test");
  } finally {
    if (handle) await handle.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousDeepRepairDisable === undefined) delete process.env.WAND_PATH_REPAIR_DEEP_DISABLE;
    else process.env.WAND_PATH_REPAIR_DEEP_DISABLE = previousDeepRepairDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings validate atomically, persist without secrets, and password rotation revokes tokens", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-settings-atomic-"));
  const configPath = path.join(dir, "config.json");
  const config = {
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
  };
  const handle = await startServer(config, configPath);

  try {
    const baseUrl = handle.urls[0]!.url;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
    });
    assert.equal(login.status, 200);
    const { appToken, principal } = await login.json() as { appToken?: string; principal?: { kind?: string } };
    assert.ok(appToken);
    assert.equal(principal?.kind, "browser-admin");
    const adminCookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const headers = { Cookie: adminCookie, "Content-Type": "application/json" };
    const connectedHeaders = { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" };

    const connectedLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appToken }),
    });
    assert.equal(connectedLogin.status, 200);
    const connectedLoginBody = await connectedLogin.json() as { principal?: { kind?: string } };
    assert.equal(connectedLoginBody.principal?.kind, "connected-app");
    const connectedCookie = connectedLogin.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const connectedCookieHeaders = { Cookie: connectedCookie };
    const connectedConfigResponse = await fetch(`${baseUrl}/api/config`, { headers: connectedCookieHeaders });
    assert.equal(connectedConfigResponse.status, 200);
    const connectedConfig = await connectedConfigResponse.json() as { canManageSettings?: boolean };
    assert.equal(connectedConfig.canManageSettings, false);
    assert.equal((await fetch(`${baseUrl}/api/models`, { headers: connectedCookieHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/models`, { headers: { Authorization: "Bearer not-a-token" } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/settings`, { headers: connectedCookieHeaders })).status, 403);
    const connectedAboutResponse = await fetch(`${baseUrl}/api/settings/about`, { headers: connectedCookieHeaders });
    assert.equal(connectedAboutResponse.status, 200);
    const connectedAbout = await connectedAboutResponse.json() as Record<string, unknown> & {
      androidApk?: Record<string, unknown>;
      macosDmg?: Record<string, unknown>;
      iosIpa?: Record<string, unknown>;
    };
    assert.equal(connectedAbout.settingsAccess, "read-only");
    assert.equal(typeof connectedAbout.version, "string");
    assert.equal("config" in connectedAbout, false);
    assert.equal("autoUpdate" in connectedAbout, false);
    assert.equal("apkDir" in (connectedAbout.androidApk ?? {}), false);
    assert.equal("dmgDir" in (connectedAbout.macosDmg ?? {}), false);
    assert.equal("ipaDir" in (connectedAbout.iosIpa ?? {}), false);
    assert.equal((await fetch(`${baseUrl}/api/app-connect-code`, { headers: connectedHeaders })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview`, { headers: connectedHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview?reveal=1`, { headers: connectedHeaders })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview?reveal=true`, { headers: connectedHeaders })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview?reveal=true`, { headers: connectedCookieHeaders })).status, 403);
    const revealedEnvironment = await fetch(`${baseUrl}/api/settings/env-preview?reveal=true`, { headers });
    assert.equal(revealedEnvironment.status, 200);
    assert.equal((await revealedEnvironment.json() as { reveal: boolean }).reveal, true);

    const connectedAdminWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers: connectedHeaders,
      body: JSON.stringify({ host: "0.0.0.0" }),
    });
    assert.equal(connectedAdminWrite.status, 403);

    const connectedPreferenceWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers: connectedHeaders,
      body: JSON.stringify({ defaultThinkingEffort: "deep" }),
    });
    assert.equal(connectedPreferenceWrite.status, 200);

    const taskRetention = {
      autoArchiveEnabled: false,
      autoArchiveDays: 3,
      autoDeleteEnabled: true,
      autoDeleteDays: 14,
    };
    const connectedRetentionWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers: connectedHeaders,
      body: JSON.stringify({ taskRetention }),
    });
    assert.equal(connectedRetentionWrite.status, 403);
    const retentionWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskRetention }),
    });
    assert.equal(retentionWrite.status, 200);
    const retentionSaved = await retentionWrite.json() as {
      retention?: { archivedSessions: number; purgedSessions: number; archivedTasks: number; purgedTasks: number };
    };
    assert.deepEqual(retentionSaved.retention, {
      archivedSessions: 0,
      purgedSessions: 0,
      archivedTasks: 0,
      purgedTasks: 0,
      purgedTeamRuns: 0,
    });
    assert.deepEqual(config.taskRetention, taskRetention);
    const retentionSettings = await fetch(`${baseUrl}/api/settings`, { headers });
    assert.equal(retentionSettings.status, 200);
    const retentionBody = await retentionSettings.json() as { config: { taskRetention?: unknown } };
    assert.deepEqual(retentionBody.config.taskRetention, taskRetention);
    const retentionRejected = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskRetention: { ...taskRetention, autoDeleteDays: 0 } }),
    });
    assert.equal(retentionRejected.status, 400);
    assert.deepEqual(config.taskRetention, taskRetention);

    // 个人资料是纯展示偏好：DB 权威源、热生效、不进 config.json。
    const connectedProfileWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers: connectedHeaders,
      body: JSON.stringify({ userProfile: { name: "App 连接不该能改" } }),
    });
    assert.equal(connectedProfileWrite.status, 403, "App 连接没有管理权限，不许改用户资料");
    const profileWrite = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userProfile: { name: "赛博虎妞", avatar: "cat:3" } }),
    });
    assert.equal(profileWrite.status, 200);
    assert.deepEqual(config.userProfile, { name: "赛博虎妞", avatar: "cat:3" });
    const profileBody = await profileWrite.json() as { config: { userProfile?: unknown } };
    assert.deepEqual(profileBody.config.userProfile, { name: "赛博虎妞", avatar: "cat:3" });
    const profileRejected = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userProfile: { avatar: "https://example.com/a.png" } }),
    });
    assert.equal(profileRejected.status, 400, "非法头像明确拒绝，不静默换一张");
    assert.deepEqual(config.userProfile, { name: "赛博虎妞", avatar: "cat:3" });
    const adminProfile = await fetch(`${baseUrl}/api/config`, { headers });
    assert.deepEqual(((await adminProfile.json()) as { userProfile?: unknown }).userProfile,
      { name: "赛博虎妞", avatar: "cat:3" }, "/api/config 供客户端投影署名");

    const invalid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ host: "0.0.0.0", defaultProvider: "invalid" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.defaultProvider, "claude");
    assert.equal(existsSync(configPath), false);

    // 直连 API 偏好已经从 PREFERENCE_KEYS 移除：老客户端再提交这两个字段只会被忽略，
    // 不能顺带把别的字段写坏（原来这里断言 400 是因为 systemAi 必须是对象）。
    const removedDirectApi = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ commitAiSource: "api", systemAi: "invalid" }),
    });
    assert.equal(removedDirectApi.status, 400);
    assert.match((await removedDirectApi.json() as { error: string }).error, /没有可更新的配置字段/);
    assert.equal("systemAi" in config, false);
    assert.equal("commitAiSource" in config, false);

    const valid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        host: "0.0.0.0",
        defaultProvider: "codex",
      }),
    });
    assert.equal(valid.status, 200);
    const validBody = await valid.json() as {
      config: Record<string, unknown>;
      desiredConfig: Record<string, unknown>;
      activeConfig: Record<string, unknown>;
      restartRequired: boolean;
    };
    assert.equal(validBody.restartRequired, true);
    assert.equal("password" in validBody.config, false);
    assert.equal("appSecret" in validBody.config, false);
    // 直连 API 已移除：配置投影里不能再出现 systemAi（含密钥与 hasApiKey）。
    assert.equal("systemAi" in validBody.config, false);
    assert.equal(validBody.desiredConfig.host, "0.0.0.0");
    assert.equal(validBody.activeConfig.host, "127.0.0.1");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.defaultProvider, "codex");

    const settingsAfterUpdate = await fetch(`${baseUrl}/api/settings`, { headers });
    assert.equal(settingsAfterUpdate.status, 200);
    const settingsBody = await settingsAfterUpdate.json() as {
      desiredConfig: Record<string, unknown>;
      activeConfig: Record<string, unknown>;
      restartRequired: boolean;
    };
    assert.equal(settingsBody.desiredConfig.host, "0.0.0.0");
    assert.equal(settingsBody.activeConfig.host, "127.0.0.1");
    assert.equal(settingsBody.restartRequired, true);
    const adminConfig = await fetch(`${baseUrl}/api/config`, { headers });
    assert.equal(adminConfig.status, 200);
    assert.equal(((await adminConfig.json()) as { canManageSettings?: boolean }).canManageSettings, true);

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.host, "0.0.0.0");
    assert.equal("password" in persisted, false);
    assert.equal("appSecret" in persisted, false);
    assert.equal("systemAi" in persisted, false);
    assert.equal("systemAiCli" in persisted, false);
    assert.equal("systemAiModel" in persisted, false);
    assert.equal("taskRetention" in persisted, false);
    assert.equal("userProfile" in persisted, false, "用户资料只落 DB，不回写 config.json");

    const oversizedPrompt = await fetch(`${baseUrl}/api/optimize-prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "x".repeat(300 * 1024) }),
    });
    assert.equal(oversizedPrompt.status, 413);

    const editablePath = path.join(dir, "editable.txt");
    writeFileSync(editablePath, "before");
    const maximumText = "x".repeat(1024 * 1024);
    const fileWrite = await fetch(`${baseUrl}/api/file-write`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: editablePath, content: maximumText }),
    });
    assert.equal(fileWrite.status, 200);
    assert.equal(statSync(editablePath).size, maximumText.length);

    const passwordUpdate = await fetch(`${baseUrl}/api/set-password`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "rotated-password" }),
    });
    assert.equal(passwordUpdate.status, 200);

    const afterRotation = await fetch(`${baseUrl}/api/models`, { headers });
    assert.equal(afterRotation.status, 401);
    const oldAppToken = await fetch(`${baseUrl}/api/models`, { headers: connectedHeaders });
    assert.equal(oldAppToken.status, 401);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
