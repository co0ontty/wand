import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DwsClient, DingTalkError } from "../src/dingtalk-dws.js";

test("DWS spawn rejection before execution is definitely unsent, not an unknown remote write", async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-dws-unavailable-")); const client = new DwsClient(root, "/nonexistent/wand-fixture-dws");
  t.after(() => { client.dispose(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(client.call(["dev", "app", "robot", "submit"], { write: true }), error => error instanceof DingTalkError && error.code === "unavailable" && error.unknownDelivery === false);
  await assert.rejects(client.call(["chat", "+messages-send", "--text", "@/private/fixture-only"], { write: true }), error => error instanceof DingTalkError && error.code === "literal_argument");
});

test("explicit DWS dependency installation validates checksum and extracts only executable bytes to its private path", {
  skip: !["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch),
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "wand-dws-install-")); const client = new DwsClient(root);
  const original = globalThis.fetch, bytes = Buffer.from("fixture-program-not-executed"), header = Buffer.alloc(512);
  header.write("../../dws"); header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header[156] = 48;
  const tar = Buffer.concat([header, bytes, Buffer.alloc(512 - bytes.length), Buffer.alloc(1024)]), archive = gzipSync(tar);
  const name = `dws-${process.platform}-${process.arch === "x64" ? "amd64" : "arm64"}.tar.gz`;
  let valid = false, downloads = 0;
  globalThis.fetch = (async url => {
    downloads++;
    assert.equal(String(url).startsWith("https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.65/"), true);
    return String(url).endsWith("checksums.txt")
      ? new Response(`${valid ? createHash("sha256").update(archive).digest("hex") : "0".repeat(64)}  ${name}\n`)
      : new Response(archive);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; client.dispose(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(client.install(), /校验失败/);
  valid = true; const before = downloads;
  const first = client.install(), second = client.install(); assert.equal(first, second, "concurrent clicks share one installation");
  await Promise.all([first, second]); assert.equal(downloads - before, 2, "only one checksum and one archive download");
  const installed = join(root, "dingtalk", "bin", "dws"); assert.equal(readFileSync(installed, "utf8"), bytes.toString());
  assert.equal(statSync(installed).mode & 0o777, 0o700);
});
