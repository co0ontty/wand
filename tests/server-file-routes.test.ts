import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { jsonErrorHandler } from "../src/express-async.js";
import { registerFileRoutes } from "../src/server-file-routes.js";
import { WandStorage } from "../src/storage.js";

test("extracted file routes preserve directory, preview, write, range, recent, and search behavior", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-file-routes-"));
  const filePath = path.join(root, "sample.txt");
  writeFileSync(filePath, "hello world");
  const storage = new WandStorage(path.join(root, "wand.db"));

  const app = express();
  app.use(express.json());
  registerFileRoutes(app, { storage, defaultCwd: root });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const directory = await fetch(`${baseUrl}/api/directory?q=${encodeURIComponent(root)}`);
    assert.equal(directory.status, 200);
    const directoryBody = await directory.json() as { items: Array<{ name: string; type: string }> };
    assert.ok(directoryBody.items.some((item) => item.name === "sample.txt" && item.type === "file"));

    const preview = await fetch(`${baseUrl}/api/file-preview?path=${encodeURIComponent(filePath)}`);
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
      kind: "text",
      path: filePath,
      name: "sample.txt",
      ext: ".txt",
      size: 11,
      mime: "application/octet-stream",
      lang: "plaintext",
      content: "hello world",
    });

    const ranged = await fetch(`${baseUrl}/api/file-raw?path=${encodeURIComponent(filePath)}`, {
      headers: { Range: "bytes=6-10" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 6-10/11");
    assert.equal(await ranged.text(), "world");

    const invalidRange = await fetch(`${baseUrl}/api/file-raw?path=${encodeURIComponent(filePath)}`, {
      headers: { Range: "bytes=99-100" },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), "bytes */11");

    const largeTextPath = path.join(root, "large.txt");
    writeFileSync(largeTextPath, "");
    truncateSync(largeTextPath, 5 * 1024 * 1024 + 1);
    const oversizedPreview = await fetch(`${baseUrl}/api/file-raw?path=${encodeURIComponent(largeTextPath)}`);
    assert.equal(oversizedPreview.status, 413);
    const oversizedDownload = await fetch(
      `${baseUrl}/api/file-raw?download=1&path=${encodeURIComponent(largeTextPath)}`,
      { headers: { Range: "bytes=0-0" } },
    );
    assert.equal(oversizedDownload.status, 206);
    assert.match(oversizedDownload.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal((await oversizedDownload.arrayBuffer()).byteLength, 1);

    const write = await fetch(`${baseUrl}/api/file-write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, content: "updated" }),
    });
    assert.equal(write.status, 200);
    assert.equal(readFileSync(filePath, "utf8"), "updated");

    const validate = await fetch(`${baseUrl}/api/validate-path?path=${encodeURIComponent(root)}`);
    assert.equal(validate.status, 200);
    assert.equal((await validate.json() as { valid: boolean }).valid, true);

    const recentWrite = await fetch(`${baseUrl}/api/recent-paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: root }),
    });
    assert.equal(recentWrite.status, 200);
    const recentRead = await fetch(`${baseUrl}/api/recent-paths`);
    const recent = await recentRead.json() as Array<{ path: string }>;
    assert.equal(recent[0]?.path, root);

    const sourceDir = path.join(process.cwd(), "src");
    const search = await fetch(`${baseUrl}/api/file-search?q=server-file-routes&cwd=${encodeURIComponent(sourceDir)}&depth=0`);
    assert.equal(search.status, 200);
    const searchBody = await search.json() as { results: Array<{ name: string }> };
    assert.ok(searchBody.results.some((item) => item.name === "server-file-routes.ts"));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
