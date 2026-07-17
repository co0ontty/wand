import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AuthService,
  CONNECTED_APP_PRINCIPAL,
} from "../src/auth.js";
import { defaultConfig, loadConfigWithStorage, saveConfig } from "../src/config.js";
import {
  buildProviderResumeCommand,
  getProviderCommandSessionId,
  getProviderResumeCommandSessionId,
  isProviderSessionId,
  isSafeProviderSessionId,
} from "../src/resume-policy.js";
import { parseExecutionMode } from "../src/server-session-routes.js";
import { WandStorage } from "../src/storage.js";

test("provider session IDs reject shell input", () => {
  assert.equal(isProviderSessionId("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isProviderSessionId("123e4567-e89b-12d3-a456-426614174000; touch /tmp/pwned"), false);
  assert.equal(isProviderSessionId("$(touch /tmp/pwned)"), false);
});

test("PTY resume policy supports every provider-native CLI syntax", () => {
  const cases = [
    ["claude", "claude --model sonnet", "session-1", "claude --model sonnet --resume session-1"],
    ["codex", "codex --no-alt-screen", "thread-1", "codex --no-alt-screen resume thread-1"],
    ["opencode", "opencode --mini", "ses_123", "opencode --mini --session ses_123"],
    ["grok", "grok --minimal", "019f6f1f-fd54-7d40-aa70-9f42f1be2a03", "grok --minimal --resume 019f6f1f-fd54-7d40-aa70-9f42f1be2a03"],
    ["qoder", "qodercli --model coder", "qs_123", "qodercli --model coder --resume qs_123"],
  ] as const;

  for (const [provider, command, id, expected] of cases) {
    assert.equal(isSafeProviderSessionId(id), true);
    const resumed = buildProviderResumeCommand(provider, command, id);
    assert.equal(resumed, expected);
    assert.equal(getProviderResumeCommandSessionId(provider, resumed), id);
    assert.equal(buildProviderResumeCommand(provider, resumed, id), expected);
  }
});

test("PTY resume replaces a caller-assigned Grok or Qoder session ID", () => {
  for (const provider of ["grok", "qoder"] as const) {
    const executable = provider === "qoder" ? "qodercli" : provider;
    const command = `${executable} --session-id original-id`;
    assert.equal(getProviderCommandSessionId(provider, command), "original-id");
    assert.equal(
      buildProviderResumeCommand(provider, command, "restored-id"),
      `${executable} --resume restored-id`,
    );
  }
});

test("PTY resume policy rejects command injection in non-UUID provider IDs", () => {
  for (const value of ["ses_123;touch", "$(touch-pwned)", "id with spaces", "--flag"]) {
    assert.equal(isSafeProviderSessionId(value), false);
    assert.throws(() => buildProviderResumeCommand("opencode", "opencode", value), /格式无效/);
  }
});

test("execution mode parser rejects supplied invalid values", () => {
  assert.equal(parseExecutionMode(undefined, "default"), "default");
  assert.equal(parseExecutionMode("assist", "default"), "assist");
  assert.throws(() => parseExecutionMode("managd", "managed"), /无效执行模式/);
  assert.throws(() => parseExecutionMode(null, "managed"), /无效执行模式/);
});

test("config persistence excludes runtime secrets and uses private permissions", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-config-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const config = defaultConfig();
  config.password = "super-secret-password";
  config.appSecret = "a".repeat(64);

  await saveConfig(configPath, config);

  const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal("password" in persisted, false);
  assert.equal("appSecret" in persisted, false);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});

test("config:show redacts every runtime secret", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-config-show-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const password = "config-show-password";
  const appSecret = "c".repeat(64);
  const apiKey = "config-show-api-key";
  writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1" }));

  const storage = new WandStorage(path.join(dir, "wand.db"));
  storage.setPassword(password);
  storage.setAppSecret(appSecret);
  storage.setPreference("pref:systemAi", {
    enabled: false,
    protocol: "openai",
    baseUrl: "https://api.example.test/v1",
    apiKey,
    model: "test-model",
  });
  storage.close();

  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const output = execFileSync(process.execPath, [
    "--import", "tsx", cliPath, "config:show", "-c", configPath,
  ], { encoding: "utf8", cwd: path.dirname(cliPath) });
  const displayed = JSON.parse(output) as {
    password?: string;
    appSecret?: string;
    systemAi?: { apiKey?: string };
  };

  assert.equal(displayed.password, "<set>");
  assert.equal(displayed.appSecret, "<set>");
  assert.equal(displayed.systemAi?.apiKey, "<set>");
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(appSecret), false);
  assert.equal(output.includes(apiKey), false);
});

test("config loading never copies provider CLI credentials", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-no-credential-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://proxy.example.test",
      ANTHROPIC_AUTH_TOKEN: "must-not-be-copied",
    },
    model: "test-model",
  }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const storage = new WandStorage(path.join(dir, "wand.db"));
  try {
    const config = await loadConfigWithStorage(path.join(dir, "config.json"), storage);
    assert.equal(config.systemAi?.apiKey, "");
    assert.equal(storage.hasPreference("pref:systemAi"), false);
  } finally {
    storage.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("SQLite storage repairs database permissions", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-storage-security-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "wand.db");
  const storage = new WandStorage(dbPath);
  storage.close();

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});

test("legacy JSON secrets migrate to SQLite and are removed from config", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-secret-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const dbPath = path.join(dir, "wand.db");
  const password = "legacy-password";
  const appSecret = "b".repeat(64);
  writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", password, appSecret }));
  const storage = new WandStorage(dbPath);
  t.after(() => storage.close());

  const runtime = await loadConfigWithStorage(configPath, storage);
  const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  assert.equal(runtime.password, password);
  assert.equal(runtime.appSecret, appSecret);
  assert.equal(storage.getPassword(), password);
  assert.equal(storage.getAppSecret(), appSecret);
  assert.equal("password" in persisted, false);
  assert.equal("appSecret" in persisted, false);
});

test("global credential rotation revokes persisted and in-memory sessions", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-auth-revoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(dir, "wand.db"));
  const auth = new AuthService(storage);
  const first = auth.createSession();
  const second = auth.createSession();
  assert.equal(auth.validateSession(first), true);
  assert.equal(auth.validateSession(second), true);

  auth.revokeAllSessions();

  assert.equal(auth.validateSession(first), false);
  assert.equal(auth.validateSession(second), false);
  auth.dispose();
  storage.close();
});

test("AuthService instances isolate in-memory tokens across simultaneous servers", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-auth-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const firstStorage = new WandStorage(path.join(dir, "first.db"));
  const secondStorage = new WandStorage(path.join(dir, "second.db"));
  const firstAuth = new AuthService(firstStorage);
  const secondAuth = new AuthService(secondStorage);
  t.after(() => {
    firstAuth.dispose();
    secondAuth.dispose();
    firstStorage.close();
    secondStorage.close();
  });

  const firstToken = firstAuth.createSession();
  const secondToken = secondAuth.createSession();
  assert.equal(firstAuth.validateSession(firstToken), true);
  assert.equal(firstAuth.validateSession(secondToken), false);
  assert.equal(secondAuth.validateSession(firstToken), false);
  assert.equal(secondAuth.validateSession(secondToken), true);
});

test("auth principals persist and legacy sessions migrate as browser admins", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-auth-principal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacyPath = path.join(dir, "legacy.db");
  const legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec("CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
  legacyDb.prepare("INSERT INTO auth_sessions (token, expires_at) VALUES (?, ?)")
    .run("legacy-admin", Date.now() + 60_000);
  legacyDb.close();

  const legacyStorage = new WandStorage(legacyPath);
  assert.deepEqual(legacyStorage.getAuthSession("legacy-admin")?.principal, {
    kind: "browser-admin",
    scopes: ["admin"],
  });
  legacyStorage.close();

  const connectedPath = path.join(dir, "connected.db");
  const connectedStorage = new WandStorage(connectedPath);
  const connectedAuth = new AuthService(connectedStorage);
  const token = connectedAuth.createSession(CONNECTED_APP_PRINCIPAL);
  connectedStorage.saveAuthSession("expired-connected", Date.now() - 1, CONNECTED_APP_PRINCIPAL);
  assert.equal(connectedAuth.authenticateSession("expired-connected"), null);
  assert.equal(connectedStorage.getAuthSession("expired-connected"), null);
  connectedAuth.dispose();
  const rehydratedAuth = new AuthService(connectedStorage);
  assert.deepEqual(rehydratedAuth.authenticateSession(token), CONNECTED_APP_PRINCIPAL);
  rehydratedAuth.dispose();
  connectedStorage.close();

  const corruptDb = new DatabaseSync(connectedPath);
  corruptDb.prepare("UPDATE auth_sessions SET scopes = ? WHERE token = ?").run("{bad-json", token);
  corruptDb.close();
  const corruptStorage = new WandStorage(connectedPath);
  assert.deepEqual(corruptStorage.getAuthSession(token)?.principal, {
    kind: "connected-app",
    scopes: [],
  });
  corruptStorage.close();
});
