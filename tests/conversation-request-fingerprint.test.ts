import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { sha256Hex } from "../src/web-ui/react/sha256.ts";

function replaceGlobal(t: { after(action: () => void): void }, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  });
}

const vectors = ["", "abc", "帖子与提示词🐯\n\0下一段", "\ud800", "é日本語العربية",
  ...[55, 56, 63, 64, 65, 127, 128, 256_000].map(length => "x".repeat(length))];

test("native and LAN HTTP SHA-256 keep identical UTF-8 fingerprints, including Unicode, NUL and multiple blocks", async t => {
  replaceGlobal(t, "crypto", webcrypto);
  for (const crypto of [webcrypto, { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }]) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    for (const value of vectors) {
      const expected = createHash("sha256").update(value).digest("hex");
      assert.equal(await sha256Hex(value), expected);
    }
  }
});

test("production split ESM SHA-256 fallback preserves every fingerprint vector", async t => {
  const dir = mkdtempSync(join(tmpdir(), "wand-hash-esm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  replaceGlobal(t, "crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  await build({ entryPoints: { fingerprint: fileURLToPath(new URL("../src/web-ui/react/sha256.ts", import.meta.url)) },
    bundle: true, splitting: true, minify: true, platform: "browser", format: "esm", target: "es2020",
    outdir: dir, outExtension: { ".js": ".mjs" }, logLevel: "warning" });
  const { sha256Hex: bundledHash } = await import(pathToFileURL(join(dir, "fingerprint.mjs")).href);
  for (const value of vectors) {
    assert.equal(await bundledHash(value), createHash("sha256").update(value).digest("hex"));
  }
});

test("LAN HTTP conversations retain old unresolved keys and block uncertain duplicates until receipt reconciliation", async t => {
  const key = "wand-conversation-requests-v1";
  const path = "/api/conversations/dm_e_isolated/send";
  const body = { input: "帖子🐯\n\0保留旧指纹", target: null };
  const fingerprint = createHash("sha256").update(path + "\0" + JSON.stringify(body)).digest("hex");
  const oldId = "old-request-12345678";
  const saved = new Map([[key, JSON.stringify({ [fingerprint]: oldId })]]);
  replaceGlobal(t, "localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => { saved.set(name, value); },
  });
  replaceGlobal(t, "crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  let mode = "accepted";
  const calls: Array<{ path: string; requestId: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const requestId = init?.body ? JSON.parse(String(init.body)).requestId as string : null;
    calls.push({ path: String(url), requestId });
    if (!init?.body) return new Response(JSON.stringify({ requestId: String(url).split("/").at(-1), state: "accepted", conversationId: "dm_e_isolated" }));
    if (mode === "transport") throw new TypeError("isolated transport failure");
    if (mode === "5xx") return new Response('{"error":"isolated upstream failure"}', { status: 503 });
    if (mode === "malformed") return new Response("not-json");
    if (mode === "rejected") return new Response('{"error":"isolated rejection"}', { status: 403 });
    return new Response(JSON.stringify({ requestId, state: mode === "pending" ? "pending" : "accepted", conversationId: "dm_e_isolated" }));
  });
  const { conversationsRepository: repository, UnconfirmedConversationError } = await import("../src/web-ui/react/conversations/repository.ts");
  await assert.rejects(repository.post(path, body), error => error instanceof UnconfirmedConversationError && error.requestId === oldId);
  assert.equal(calls.length, 0, "old WebCrypto fingerprints still stop duplicate submission before fetch");
  await repository.reconcile(oldId);
  assert.deepEqual(JSON.parse(saved.get(key)!), {});

  for (const failure of ["transport", "5xx", "malformed", "pending"]) {
    mode = failure;
    const uncertainBody = { ...body, failure };
    let uncertainId = "";
    await assert.rejects(repository.post(path, uncertainBody), error => {
      assert.ok(error instanceof UnconfirmedConversationError);
      uncertainId = error.requestId;
      assert.match(uncertainId, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
      return true;
    });
    const uncertainFingerprint = createHash("sha256").update(path + "\0" + JSON.stringify(uncertainBody)).digest("hex");
    assert.equal(JSON.parse(saved.get(key)!)[uncertainFingerprint], uncertainId);
    const submitted = calls.length;
    await assert.rejects(repository.post(path, uncertainBody), error => error instanceof UnconfirmedConversationError && error.requestId === uncertainId);
    assert.equal(calls.length, submitted, "an unknown result does not issue another request");
    await repository.reconcile(uncertainId);
    mode = "accepted";
    const accepted = await repository.post(path, uncertainBody);
    assert.equal(accepted.state, "accepted");
    assert.notEqual(accepted.requestId, uncertainId);
    assert.deepEqual(JSON.parse(saved.get(key)!), {});
  }
  mode = "rejected";
  await assert.rejects(repository.post(path, { ...body, rejected: true }), /isolated rejection/);
  assert.deepEqual(JSON.parse(saved.get(key)!), {}, "explicit rejection removes only the unsent input's lock");
});
