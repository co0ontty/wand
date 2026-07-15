import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

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
    };
    assert.equal(connectedAbout.settingsAccess, "read-only");
    assert.equal(typeof connectedAbout.version, "string");
    assert.equal("config" in connectedAbout, false);
    assert.equal("autoUpdate" in connectedAbout, false);
    assert.equal("apkDir" in (connectedAbout.androidApk ?? {}), false);
    assert.equal("dmgDir" in (connectedAbout.macosDmg ?? {}), false);
    assert.equal((await fetch(`${baseUrl}/api/app-connect-code`, { headers: connectedHeaders })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview`, { headers: connectedHeaders })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/settings/env-preview?reveal=1`, { headers: connectedHeaders })).status, 403);

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

    const invalid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ host: "0.0.0.0", defaultProvider: "invalid" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.defaultProvider, "claude");
    assert.equal(existsSync(configPath), false);

    const valid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ host: "0.0.0.0", defaultProvider: "codex", structuredRunner: "sdk" }),
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
    assert.equal(validBody.desiredConfig.host, "0.0.0.0");
    assert.equal(validBody.activeConfig.host, "127.0.0.1");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.defaultProvider, "codex");
    assert.equal(config.structuredRunner, "sdk");

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
