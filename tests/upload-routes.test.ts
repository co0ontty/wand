import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import type { SessionSnapshot } from "../src/types.js";
import { registerUploadRoutes } from "../src/upload-routes.js";
import type { ManagedUpload } from "../src/storage/uploads-repository.js";
import { TEMP_ROOT_MARKER } from "../src/managed-temp.ts";

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
  assert.deepEqual(await missing.json(), { error: "会话不存在。", code: "not_found" });

  const invalid = await upload(url, "bad-cwd", "note.txt");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "会话工作目录无效。", code: "bad_request" });
});

test("upload directory quota rejects overflow and removes the rejected files", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-upload-quota-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const app = express();
  registerUploadRoutes(app, {
    getLatest(id) {
      return id === "quota" ? { id, cwd } as never : null;
    },
  }, { maxDirBytes: 64 });
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const send = (size: number) => {
    const form = new FormData();
    form.append("files", new Blob([Buffer.alloc(size, 97)]), "blob.txt");
    return fetch(`${url}/api/sessions/quota/upload`, { method: "POST", body: form });
  };

  const first = await send(40);
  assert.equal(first.status, 200);
  const second = await send(40);
  assert.equal(second.status, 413);
  assert.equal((await second.json() as { code: string }).code, "payload_too_large");
  const stored = readdirSync(path.join(cwd, ".wand-uploads"));
  assert.equal(stored.length, 1, "rejected upload is not left on disk");
});

test("concurrent uploads reserve quota atomically and persist ownership before returning files", async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wand-upload-receipt-"));
  const receipts: Omit<ManagedUpload, "orphanedAt">[] = [];
  const app = express();
  registerUploadRoutes(app, { getLatest: () => ({ id: "owner", cwd } as SessionSnapshot) },
    { maxDirBytes: 64, temporaryRoot: path.join(realpathSync(cwd), "temporary"), uploads: { recordManagedUploads: rows => { receipts.push(...rows); } } });
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessions/owner/upload`;
  const send = () => { const form = new FormData(); form.append("files", new Blob([Buffer.alloc(40)]), "notes.txt"); return fetch(url, { method: "POST", body: form }); };
  const replies = await Promise.all([send(), send()]); assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 413]);
  assert.equal(receipts.length, 1); const row = receipts[0]!; const stat = lstatSync(row.canonicalPath);
  assert.equal(row.sessionId, "owner"); assert.equal(row.inode, stat.ino); assert.equal(row.device, stat.dev); assert.equal(row.size, 40);
  assert.equal(readdirSync(path.join(cwd, ".wand-uploads")).length, 1);
  for (let i = 0; i < 100 && readdirSync(path.join(cwd, "temporary")).length > 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(readdirSync(path.join(cwd, "temporary")), [TEMP_ROOT_MARKER]);
});

test("disconnected multipart upload closes its writer and removes unfinished staging", async t => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wand-upload-disconnect-")));
  const temporaryRoot = path.join(cwd, "temporary");
  const receipts: unknown[] = [];
  const app = express();
  registerUploadRoutes(app, { getLatest: () => ({ id: "owner", cwd } as SessionSnapshot) },
    { temporaryRoot, uploads: { recordManagedUploads: rows => { receipts.push(...rows); } } });
  app.use(jsonErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }); });
  const client = request({ hostname: "127.0.0.1", port: (server.address() as { port: number }).port,
    method: "POST", path: "/api/sessions/owner/upload", headers: { "Content-Type": "multipart/form-data; boundary=wand-cancel-test" } });
  client.on("error", () => undefined);
  client.write('--wand-cancel-test\r\nContent-Disposition: form-data; name="files"; filename="incomplete.txt"\r\nContent-Type: text/plain\r\n\r\n');
  client.write(Buffer.alloc(8192, 97));
  let staged = false;
  for (let i = 0; i < 200; i++) {
    try { staged = readdirSync(temporaryRoot).some(name => name !== TEMP_ROOT_MARKER); } catch { /* not created yet */ }
    if (staged) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(staged, true, "request reached the disk staging path");
  client.destroy();
  for (let i = 0; i < 200 && readdirSync(temporaryRoot).length > 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(readdirSync(temporaryRoot), [TEMP_ROOT_MARKER]);
  assert.deepEqual(readdirSync(path.join(cwd, ".wand-uploads")), []);
  assert.deepEqual(receipts, []);
});
