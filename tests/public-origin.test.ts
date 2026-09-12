import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

/**
 * TLS 由 L4 反代终止时（nginx stream / Nginx Proxy Manager 的 TCP stream），node 只看到明文
 * HTTP，既没有 X-Forwarded-Proto 也猜不出 scheme。这类部署必须能显式声明公开 origin，
 * 否则 `/api/app-connect-code` 会把 `https://host:tls-port` 写成 `http://host:tls-port`，
 * 手机端拿着连接码打 TLS 端口发明的明文请求，表现为“连不上服务端”。
 */
async function withServer(
  config: ReturnType<typeof defaultConfig>,
  run: (baseUrl: string, cookie: string, appToken: string) => Promise<void>,
): Promise<void> {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-public-origin-"));
  const configPath = path.join(dir, "config.json");
  const handle = await startServer(config, configPath);
  try {
    const baseUrl = handle.urls[0]!.url;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: config.password, client: "browser-extension" }),
    });
    assert.equal(login.status, 200);
    const payload = await login.json() as { appToken?: string };
    const appToken = payload.appToken ?? "";
    assert.equal(typeof appToken, "string");
    assert.ok(appToken.length > 0);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    await run(baseUrl, cookie, appToken);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function decodeConnectCode(code: string): string {
  return Buffer.from(code, "base64").toString("utf8").split("#")[0] ?? "";
}

test("app connect code prefers configured publicOrigin over the proxied request scheme", async () => {
  const config = {
    ...defaultConfig(),
    host: "0.0.0.0",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
    // 反代终止 TLS，node 只收到明文；公开入口是 https。
    publicOrigin: "https://home.example.com:8443",
  };
  await withServer(config, async (baseUrl, cookie) => {
    const response = await fetch(`${baseUrl}/api/app-connect-code`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as { url?: string; code?: string };
    assert.equal(body.url, "https://home.example.com:8443");
    assert.equal(decodeConnectCode(body.code ?? ""), "https://home.example.com:8443");
  });
});

test("configured publicOrigin wins over a conflicting browser origin", async () => {
  const config = {
    ...defaultConfig(),
    host: "0.0.0.0",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
    publicOrigin: "https://home.example.com:8443",
  };
  await withServer(config, async (baseUrl, cookie, appToken) => {
    const response = await fetch(
      `${baseUrl}/api/app-connect-code?origin=${encodeURIComponent("https://home.example.com:8443")}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { url?: string };
    assert.equal(body.url, "https://home.example.com:8443");

    // 浏览器 extension 登录会把同一个公开 origin 作为 serverUrl 下发。
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appToken, client: "browser-extension" }),
    });
    assert.equal(login.status, 200);
    const payload = await login.json() as { serverUrl?: string };
    assert.equal(payload.serverUrl, "https://home.example.com:8443");
  });
});

test("without publicOrigin the request scheme is still used", async () => {
  const config = {
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
  };
  await withServer(config, async (baseUrl, cookie) => {
    const response = await fetch(`${baseUrl}/api/app-connect-code`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const body = await response.json() as { url?: string };
    assert.match(body.url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(decodeConnectCode(body.code ?? ""), body.url);
  });
});

test("invalid publicOrigin values are ignored instead of crashing startup", async () => {
  for (const invalid of ["not a url", "ftp://home.example.com", "javascript:alert(1)"]) {
    const config = {
      ...defaultConfig(),
      host: "127.0.0.1",
      port: 0,
      https: false,
      password: "test-password",
      appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      startupCommands: [],
      publicOrigin: invalid,
    };
    await withServer(config, async (baseUrl, cookie) => {
      const response = await fetch(`${baseUrl}/api/app-connect-code`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = await response.json() as { url?: string };
      assert.match(body.url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/, `invalid value ${invalid} must fall back`);
    });
  }
});
