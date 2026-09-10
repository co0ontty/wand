import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

test("GitHub connector validates, encrypts, and proxies repository workflows", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-github-connector-"));
  const requests: Array<{ method: string; url: string; authorization: string }> = [];
  const github = createServer((req, res) => {
    requests.push({ method: req.method || "", url: req.url || "", authorization: req.headers.authorization || "" });
    res.setHeader("content-type", "application/json");
    res.setHeader("x-oauth-scopes", "repo, read:org");
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      if (req.url === "/user") {
        res.end(JSON.stringify({ login: "wand-owner" }));
        return;
      }
      if (req.url?.startsWith("/user/repos")) {
        res.end(JSON.stringify([{ name: "wand", private: true }]));
        return;
      }
      if (req.method === "POST" && req.url === "/repos/co0ontty/wand/issues") {
        assert.deepEqual(JSON.parse(raw), { title: "整理需求", body: "拆分验收标准" });
        res.statusCode = 201;
        res.end(JSON.stringify({ number: 42, title: "整理需求" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "not found" }));
    });
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  const address = github.address();
  assert.ok(address && typeof address === "object");

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
      body: JSON.stringify({ password: "test-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const apiUrl = `http://127.0.0.1:${address.port}`;

    const connect = await fetch(`${baseUrl}/api/connectors/github`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "github_pat_test_secret", apiUrl }),
    });
    assert.equal(connect.status, 200);
    const connector = await connect.json() as { connected?: boolean; username?: string; scopes?: string[] };
    assert.equal(connector.connected, true);
    assert.equal(connector.username, "wand-owner");
    assert.deepEqual(connector.scopes, ["repo", "read:org"]);

    const repos = await fetch(`${baseUrl}/api/github/repos?per_page=1`, { headers });
    assert.equal(repos.status, 200);
    assert.deepEqual(await repos.json(), [{ name: "wand", private: true }]);

    const issue = await fetch(`${baseUrl}/api/github/repos/co0ontty/wand/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "整理需求", body: "拆分验收标准" }),
    });
    assert.equal(issue.status, 201);
    assert.equal((await issue.json() as { number: number }).number, 42);
    assert.ok(requests.every((request) => request.authorization === "Bearer github_pat_test_secret"));

    const status = await fetch(`${baseUrl}/api/connectors/github`, { headers });
    const statusBody = await status.json() as { connected?: boolean; username?: string };
    assert.equal(statusBody.connected, true);
    assert.equal(statusBody.username, "wand-owner");
  } finally {
    await handle.close();
    await new Promise<void>((resolve, reject) => github.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
