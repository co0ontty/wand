import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import {
  DEFAULT_BROWSER_EXTENSION_BASE_URL,
  buildPasswordSecurityReport,
  generatePassword,
  generateTotpCode,
  scorePasswordStrength,
} from "../src/password-manager.js";
import { startServer } from "../src/server.js";
import { WandStorage } from "../src/storage.js";
import { generatePassword as generateExtensionPassword } from "../browser-extension/shared/password-tools.mjs";
import { DEFAULT_BASE_URL, normalizeBaseUrl, urlsMatch as extensionUrlsMatch } from "../browser-extension/shared/url-tools.mjs";
import {
  base64UrlDecode,
  base64UrlEncode,
  createPasskeyCredential,
  getPasskeyAssertion,
  passkeyMatchesRequest,
} from "../browser-extension/shared/webauthn-tools.mjs";

test("password generator, strength scoring, and TOTP match expected behavior", () => {
  const password = generatePassword({ length: 24 });
  assert.equal(password.length, 24);
  assert.ok(/[a-z]/.test(password));
  assert.ok(/[A-Z]/.test(password));
  assert.ok(/\d/.test(password));
  assert.ok(/[^A-Za-z0-9]/.test(password));
  assert.equal(scorePasswordStrength("password"), 0);
  assert.ok(scorePasswordStrength(password) >= 70);
  assert.equal(generateTotpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 8, 30), "94287082");
});

test("browser extension shared tools align with server defaults", () => {
  const password = generateExtensionPassword({ length: 18, symbols: false });
  assert.equal(password.length, 18);
  assert.equal(DEFAULT_BASE_URL, DEFAULT_BROWSER_EXTENSION_BASE_URL);
  assert.equal(normalizeBaseUrl(" https://home.huniu.fun:8183/ "), DEFAULT_BROWSER_EXTENSION_BASE_URL);
  assert.equal(extensionUrlsMatch("https://example.com/login", "https://www.example.com/login/reset"), true);
});

test("browser extension install onboarding has server URL and password setup", () => {
  const manifest = JSON.parse(readFileSync("browser-extension/manifest.json", "utf8")) as {
    options_page?: string;
    permissions?: string[];
  };
  assert.equal(manifest.options_page, "src/options.html");
  assert.ok(manifest.permissions?.includes("storage"));

  const optionsHtml = readFileSync("browser-extension/src/options.html", "utf8");
  assert.match(optionsHtml, /id="baseUrl"/);
  assert.match(optionsHtml, /value="https:\/\/home\.huniu\.fun:8183"/);
  assert.match(optionsHtml, /id="password"/);
  assert.match(optionsHtml, /autocomplete="current-password"/);

  const backgroundJs = readFileSync("browser-extension/src/background.js", "utf8");
  assert.match(backgroundJs, /onInstalled\.addListener/);
  assert.match(backgroundJs, /details\.reason === "install"/);
  assert.match(backgroundJs, /saveSettings\(\{ baseUrl: DEFAULT_BASE_URL/);
  assert.match(backgroundJs, /chrome\.runtime\.openOptionsPage\(\)/);
});

test("browser extension passkey tools create and assert ES256 WebAuthn credentials", async () => {
  const creationOptions = {
    challenge: base64UrlEncode(new Uint8Array([1, 2, 3, 4])),
    rp: { id: "example.com", name: "Example" },
    user: {
      id: base64UrlEncode(new Uint8Array([5, 6, 7, 8])),
      name: "ada@example.com",
      displayName: "Ada",
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    origin: "https://login.example.com",
  };

  const created = await createPasskeyCredential(creationOptions);
  assert.equal(created.response.type, "public-key");
  assert.equal(created.response.id, created.credentialId);
  assert.equal(created.item.type, "passkey");
  assert.equal(created.item.fields.rpId, "example.com");
  assert.ok(base64UrlDecode(created.response.response.attestationObject).length > 0);
  assert.equal(passkeyMatchesRequest(created.item, {
    rpId: "example.com",
    allowCredentials: [{ type: "public-key", id: created.credentialId }],
  }), true);

  const assertion = await getPasskeyAssertion({
    challenge: base64UrlEncode(new Uint8Array([9, 10, 11, 12])),
    rpId: "example.com",
    allowCredentials: [{ type: "public-key", id: created.credentialId }],
    origin: "https://login.example.com",
  }, created.item);

  assert.equal(assertion.signCount, 1);
  assert.equal(assertion.response.id, created.credentialId);
  assert.equal(assertion.response.response.userHandle, created.item.fields.userHandle);
  assert.equal(base64UrlDecode(assertion.response.response.signature)[0], 0x30);
});

test("storage creates vaults, stores items, filters by URL, and reports risks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-passwords-"));
  const storage = new WandStorage(path.join(dir, "wand.db"));
  try {
    const vaults = storage.listPasswordVaults();
    assert.equal(vaults[0]?.id, "personal");

    const weak = storage.createPasswordItem({
      type: "login",
      title: "Example",
      username: "ada",
      password: "password",
      urls: ["https://example.com/login"],
    });
    const reused = storage.createPasswordItem({
      type: "login",
      title: "Subdomain",
      username: "ada2",
      password: "password",
      urls: ["https://accounts.example.com/"],
    });
    storage.createPasswordItem({
      type: "identity",
      title: "Ada",
      fields: { email: "ada@example.com", phone: "123" },
    });

    const matched = storage.listPasswordItems({ url: "https://www.example.com/login/reset", type: "login" });
    assert.equal(matched.length, 1);
    assert.equal(matched[0]?.id, weak.id);

    const report = buildPasswordSecurityReport(storage.listPasswordItems({ limit: 20 }));
    assert.equal(report.loginItems, 2);
    assert.equal(report.weakPasswords, 2);
    assert.equal(report.reusedPasswords, 2);

    assert.equal(storage.deletePasswordItem(reused.id), true);
    assert.equal(storage.getPasswordItem(reused.id), null);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server issues browser extension token and protects password vault APIs", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-server-"));
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
    const denied = await fetch(`${baseUrl}/api/browser-extension/status`);
    assert.equal(denied.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
    });
    const loginBody = await login.json() as { appToken?: string; serverUrl?: string };
    assert.equal(login.status, 200);
    assert.ok(loginBody.appToken);
    assert.equal(loginBody.serverUrl, DEFAULT_BROWSER_EXTENSION_BASE_URL);

    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginBody.appToken}`,
    };
    const status = await fetch(`${baseUrl}/api/browser-extension/status`, { headers: authHeaders });
    const statusBody = await status.json() as { features?: { passkeys?: string; federatedLoginMemory?: boolean } };
    assert.equal(statusBody.features?.passkeys, "webauthn-proxy");
    assert.equal(statusBody.features?.federatedLoginMemory, true);

    const created = await fetch(`${baseUrl}/api/browser-extension/items`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        type: "login",
        title: "Example",
        username: "user",
        password: "CorrectHorseBatteryStaple!42",
        urls: ["https://example.com/login"],
        fields: { totpSecret: "GEZDGNBVGY3TQOJQ" },
      }),
    });
    assert.equal(created.status, 201);

    const matches = await fetch(`${baseUrl}/api/browser-extension/items?url=${encodeURIComponent("https://app.example.com/login")}`, {
      headers: authHeaders,
    });
    const matchBody = await matches.json() as { items?: Array<{ title: string }> };
    assert.equal(matchBody.items?.length, 1);
    assert.equal(matchBody.items?.[0]?.title, "Example");

    const report = await fetch(`${baseUrl}/api/browser-extension/security-report`, { headers: authHeaders });
    const reportBody = await report.json() as { report?: { totalItems: number } };
    assert.equal(reportBody.report?.totalItems, 1);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
