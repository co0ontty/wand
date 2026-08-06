import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

test("session directory reads and renames require the sessions scope", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-directory-auth-"));
  const previousTestMode = process.env.WAND_TEST_MODE;
  process.env.WAND_TEST_MODE = "1";
  t.after(() => {
    if (previousTestMode === undefined) delete process.env.WAND_TEST_MODE;
    else process.env.WAND_TEST_MODE = previousTestMode;
    rmSync(root, { recursive: true, force: true });
  });

  const password = "directory-auth-password";
  const appSecret = "directory-auth-secret";
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password,
    appSecret,
    defaultCwd: root,
    startupCommands: [],
  }, path.join(root, "config.json"));
  t.after(() => handle.close());

  handle.structuredSessions.createSession({ cwd: root, mode: "assist", provider: "opencode" });
  const baseUrl = handle.urls[0].url;
  const appToken = crypto.createHmac("sha256", appSecret).update(password).digest("hex");
  const bearerHeaders = { authorization: `Bearer ${appToken}` };

  const readResponse = await fetch(`${baseUrl}/api/session-directories`, { headers: bearerHeaders });
  assert.equal(readResponse.status, 200);

  const renameResponse = await fetch(`${baseUrl}/api/session-directories/name`, {
    method: "PUT",
    headers: { ...bearerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ path: root, name: "Bearer workspace" }),
  });
  assert.equal(renameResponse.status, 200);

  const filesOnlyToken = handle.authService.createSession({
    kind: "connected-app",
    scopes: ["files"],
  });
  const cookieHeaders = { cookie: `wand_session_local=${filesOnlyToken}` };
  assert.equal(
    (await fetch(`${baseUrl}/api/session-directories`, { headers: cookieHeaders })).status,
    403,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/session-directories/name`, {
      method: "PUT",
      headers: { ...cookieHeaders, "content-type": "application/json" },
      body: JSON.stringify({ path: root, name: "Denied" }),
    })).status,
    403,
  );
});
