import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import type { SessionSnapshot } from "../src/types.js";
import { registerUploadRoutes } from "../src/upload-routes.js";

async function harness(t: TestContext): Promise<{ url: string; root: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-upload-routes-"));
  const sessionCwds = new Map([
    ["group-chat", path.join(root, "team")],
    ["pty-chat", path.join(root, "terminal")],
    ["bad-cwd", "relative/cwd"],
  ]);
  for (const cwd of sessionCwds.values()) {
    if (path.isAbsolute(cwd)) mkdirSync(cwd, { recursive: true });
  }
  const app = express();
  registerUploadRoutes(app, {
    getLatest(id) {
      const cwd = sessionCwds.get(id);
      if (!cwd) return null;
      return {
        id,
        cwd,
        sessionKind: id === "group-chat" ? "structured" : "pty",
        automationId: id === "group-chat" ? "ai-team-chat:run-1" : undefined,
      } as SessionSnapshot;
    },
  });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, root };
}

async function upload(url: string, sessionId: string, name: string): Promise<Response> {
  const form = new FormData();
  form.append("files", new Blob(["file contents"], { type: "text/plain" }), name);
  return fetch(`${url}/api/sessions/${sessionId}/upload`, { method: "POST", body: form });
}

test("team relay and PTY sessions upload through the same session route", async (t) => {
  const { url, root } = await harness(t);
  for (const [id, directory] of [["group-chat", "team"], ["pty-chat", "terminal"]]) {
    const response = await upload(url, id!, "../notes.txt");
    assert.equal(response.status, 200);
    const body = await response.json() as {
      files: Array<{ originalName: string; savedPath: string; size: number; mimeType: string }>;
    };
    assert.equal(body.files.length, 1);
    const file = body.files[0]!;
    assert.equal(file.originalName, "notes.txt");
    assert.equal(file.size, 13);
    assert.equal(file.mimeType, "text/plain");
    assert.equal(path.dirname(file.savedPath), path.join(root, directory!, ".wand-uploads"));
    assert.equal(readFileSync(file.savedPath, "utf8"), "file contents");
  }
});

test("upload rejects missing sessions and invalid working directories", async (t) => {
  const { url } = await harness(t);
  const missing = await upload(url, "missing", "note.txt");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "会话不存在。" });

  const invalid = await upload(url, "bad-cwd", "note.txt");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "会话工作目录无效。" });
});
