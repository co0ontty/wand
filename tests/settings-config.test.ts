import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createServer } from "node:http";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

test("system AI route test calls the submitted model with the saved route key", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-settings-system-ai-test-"));
  let receivedAuthorization = "";
  let receivedBody: {
    model?: string;
    reasoning_effort?: string;
    messages?: Array<{ content?: string }>;
  } = {};
  const provider = createServer((req, res) => {
    receivedAuthorization = req.headers.authorization ?? "";
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      receivedBody = JSON.parse(raw) as typeof receivedBody;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "WAND_API_OK" } }] }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");

  const configPath = path.join(dir, "config.json");
  const config = {
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
    defaultCodexModel: "different-default-model",
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
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const routeBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;

    const save = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemAi: {
          id: "route-spark",
          enabled: true,
          protocol: "openai",
          baseUrl: routeBaseUrl,
          apiKey: "saved-route-secret",
          model: "stored-model",
          authHeader: "bearer",
          source: "codex",
        },
      }),
    });
    assert.equal(save.status, 200);

    const probe = await fetch(`${baseUrl}/api/settings/system-ai/test`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        route: {
          id: "route-spark",
          enabled: true,
          protocol: "openai",
          baseUrl: routeBaseUrl,
          apiKey: "",
          hasApiKey: true,
          model: "gpt-5.3-codex-spark",
          authHeader: "bearer",
          source: "codex",
        },
      }),
    });
    assert.equal(probe.status, 200);
    const probeBody = await probe.json() as {
      ok?: boolean;
      source?: string;
      requestedModel?: string;
      reasoningEffort?: string;
      latencyMs?: number;
    };
    assert.equal(probeBody.ok, true);
    assert.equal(probeBody.source, "codex");
    assert.equal(probeBody.requestedModel, "gpt-5.3-codex-spark");
    assert.equal(probeBody.reasoningEffort, "low");
    assert.equal(typeof probeBody.latencyMs, "number");
    assert.equal(receivedAuthorization, "Bearer saved-route-secret");
    assert.equal(receivedBody.model, "gpt-5.3-codex-spark");
    assert.equal(receivedBody.reasoning_effort, "low");
    assert.match(receivedBody.messages?.[0]?.content ?? "", /WAND_API_OK/);
  } finally {
    await handle.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
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

    const importHome = path.join(dir, "import-home");
    mkdirSync(path.join(importHome, ".claude"), { recursive: true });
    writeFileSync(path.join(importHome, ".claude", "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://proxy.example.test",
        ANTHROPIC_AUTH_TOKEN: "imported-system-ai-secret",
      },
      model: "imported-model",
    }));
    mkdirSync(path.join(importHome, ".config", "opencode"), { recursive: true });
    writeFileSync(path.join(importHome, ".config", "opencode", "opencode.json"), JSON.stringify({
      model: "imported/imported-opencode-model",
      provider: { imported: { options: { baseURL: "https://opencode.example.test/v1", apiKey: "imported-opencode-secret" } } },
    }));
    const previousHome = process.env.HOME;
    process.env.HOME = importHome;
    let importedResponse: Response | undefined;
    try {
      importedResponse = await fetch(`${baseUrl}/api/settings/system-ai/import`, {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "claude" }),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    assert.ok(importedResponse);
    assert.equal(importedResponse.status, 200);
    const importedBody = await importedResponse.json() as {
      count?: number;
      systemAi?: Record<string, unknown> & {
        id?: string;
        enabled?: boolean;
        apiKey?: string;
        hasApiKey?: boolean;
        fallbacks?: Array<Record<string, unknown> & {
          id?: string;
          apiKey?: string;
          hasApiKey?: boolean;
        }>;
      };
    };
    assert.equal(importedBody.count, 2);
    assert.equal(importedBody.systemAi?.enabled, false);
    assert.equal(importedBody.systemAi?.apiKey, "");
    assert.equal(importedBody.systemAi?.hasApiKey, true);
    assert.equal(importedBody.systemAi?.fallbacks?.[0]?.apiKey, "");
    assert.equal(importedBody.systemAi?.fallbacks?.[0]?.hasApiKey, true);
    assert.equal(config.systemAi?.enabled, false);
    assert.equal(config.systemAi?.apiKey, "imported-system-ai-secret");
    assert.equal(config.systemAi?.fallbacks?.[0]?.apiKey, "imported-opencode-secret");
    assert.equal(config.commitAiSource, "cli");

    const importedPrimary = importedBody.systemAi!;
    const importedFallback = importedPrimary.fallbacks![0]!;
    assert.equal(typeof importedPrimary.id, "string");
    assert.equal(typeof importedFallback.id, "string");
    writeFileSync(path.join(importHome, ".claude", "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://proxy.example.test",
        ANTHROPIC_AUTH_TOKEN: "rotated-system-ai-secret",
      },
      model: "imported-model",
    }));
    const homeBeforeCredentialRefresh = process.env.HOME;
    process.env.HOME = importHome;
    let refreshedImport: Response | undefined;
    try {
      refreshedImport = await fetch(`${baseUrl}/api/settings/system-ai/import`, {
        method: "POST",
        headers,
      });
    } finally {
      if (homeBeforeCredentialRefresh === undefined) delete process.env.HOME;
      else process.env.HOME = homeBeforeCredentialRefresh;
    }
    assert.equal(refreshedImport?.status, 200);
    assert.equal(config.systemAi?.id, importedPrimary.id);
    assert.equal(config.systemAi?.apiKey, "rotated-system-ai-secret");
    assert.equal(config.systemAi?.fallbacks?.length, 1);
    assert.equal(config.systemAi?.fallbacks?.[0]?.id, importedFallback.id);

    const { fallbacks: _nestedFallbacks, ...primaryRoute } = importedPrimary;
    const reorderedRoutes = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemAi: {
          ...importedFallback,
          enabled: true,
          apiKey: "",
          fallbacks: [{
            ...primaryRoute,
            enabled: true,
            apiKey: "",
          }],
        },
      }),
    });
    assert.equal(reorderedRoutes.status, 200);
    assert.equal(config.systemAi?.id, importedFallback.id);
    assert.equal(config.systemAi?.apiKey, "imported-opencode-secret");
    assert.equal(config.systemAi?.fallbacks?.[0]?.id, importedPrimary.id);
    assert.equal(config.systemAi?.fallbacks?.[0]?.apiKey, "rotated-system-ai-secret");

    const duplicateRouteIds = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemAi: {
          ...importedFallback,
          enabled: true,
          apiKey: "",
          fallbacks: [{
            ...primaryRoute,
            id: importedFallback.id,
            enabled: true,
            apiKey: "",
          }],
        },
      }),
    });
    assert.equal(duplicateRouteIds.status, 400);
    assert.match((await duplicateRouteIds.json() as { error: string }).error, /路由 ID 不能重复/);
    assert.equal(config.systemAi?.apiKey, "imported-opencode-secret");
    assert.equal(config.systemAi?.fallbacks?.[0]?.apiKey, "rotated-system-ai-secret");

    const clearedRouteKey = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemAi: {
          ...importedFallback,
          enabled: true,
          apiKey: "",
          clearApiKey: true,
          fallbacks: [{
            ...primaryRoute,
            enabled: true,
            apiKey: "",
          }],
        },
      }),
    });
    assert.equal(clearedRouteKey.status, 200);
    assert.equal(config.systemAi?.enabled, true);
    assert.equal(config.systemAi?.id, importedFallback.id);
    assert.equal(config.systemAi?.apiKey, "");
    assert.equal(config.systemAi?.fallbacks?.[0]?.apiKey, "rotated-system-ai-secret");

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

    const invalidSystemAi = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ commitAiSource: "api", systemAi: "invalid" }),
    });
    assert.equal(invalidSystemAi.status, 400);
    assert.match((await invalidSystemAi.json() as { error: string }).error, /systemAi 必须是对象/);

    const autoDiscoveredDirectApi = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        commitAiSource: "api",
        systemAi: { enabled: false, baseUrl: "", apiKey: "", model: "", fallbacks: [] },
      }),
    });
    assert.equal(autoDiscoveredDirectApi.status, 200);
    assert.equal(config.commitAiSource, "api");

    const valid = await fetch(`${baseUrl}/api/settings/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        host: "0.0.0.0",
        defaultProvider: "codex",
        structuredRunner: "sdk",
        commitAiSource: "api",
        systemAi: {
          enabled: true,
          protocol: "openai",
          baseUrl: "https://llm.example.test",
          apiKey: "system-ai-secret",
          model: "custom-model",
        },
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
    assert.equal((validBody.config.systemAi as { apiKey?: string; hasApiKey?: boolean }).apiKey, "");
    assert.equal((validBody.config.systemAi as { apiKey?: string; hasApiKey?: boolean }).hasApiKey, true);
    assert.equal(validBody.desiredConfig.host, "0.0.0.0");
    assert.equal(validBody.activeConfig.host, "127.0.0.1");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.defaultProvider, "codex");
    assert.equal(config.structuredRunner, "sdk");
    assert.equal(config.commitAiSource, "api");
    assert.equal(config.systemAi?.apiKey, "system-ai-secret");

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
