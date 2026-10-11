import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { build } from "esbuild";

test("real insecure HTTP keeps SHA-256 request identity and unknown conversation delivery protection", {
  skip: process.env.WAND_CONVERSATION_FINGERPRINT_BROWSER !== "1", timeout: 60_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-fingerprint-browser-"));
  const evidence = process.env.WAND_CONVERSATION_FINGERPRINT_EVIDENCE_DIR;
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const path = "/api/conversations/dm_e_isolated/send";
  const body = { input: "隔离 HTTP 帖子🐯\n\0第二段", target: null };
  const expected = createHash("sha256").update(path + "\0" + JSON.stringify(body)).digest("hex");
  const priorId = "old-webcrypto-request-12345678";
  await build({ stdin: { contents: `import { conversationsRepository } from "./src/web-ui/react/conversations/repository";
    import { sha256Hex } from "./src/web-ui/react/sha256";
    globalThis.fingerprintFixture = { repository: conversationsRepository, sha256Hex };`,
    resolveDir: root, loader: "ts" }, bundle: true, platform: "browser", format: "iife",
    outfile: join(temp, "fixture.js"), logLevel: "warning" });
  const requests: string[] = [];
  let mode = "unknown";
  const server = createServer(async (req, res) => {
    if (req.url === "/fixture.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "fixture.js"))); return; }
    if (req.url?.startsWith("/api/")) {
      requests.push(`${req.method} ${req.url}`);
      let content = "";
      for await (const chunk of req) content += chunk;
      const requestId = req.method === "POST" ? JSON.parse(content).requestId : req.url.split("/").at(-1);
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && mode === "unknown") { res.statusCode = 503; res.end('{"error":"isolated unknown delivery"}'); return; }
      res.end(JSON.stringify({ requestId, state: "accepted", conversationId: "dm_e_isolated" })); return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><meta charset="UTF-8"><script>localStorage.setItem("wand-conversation-requests-v1",${JSON.stringify(JSON.stringify({ [expected]: priorId }))})</script><script src="/fixture.js"></script>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const profile = join(temp, "chrome");
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", "--no-proxy-server",
    "--host-resolver-rules=MAP wand-crypto-review.test 127.0.0.1", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  t.after(() => { chrome.kill(); });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 120 && !existsSync(join(profile, "DevToolsActivePort")); attempt++) await pause(50);
  const debugPort = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
  t.after(() => { socket.close(); });
  let sequence = 0;
  const pending = new Map<number, (message: any) => void>();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string): Promise<any> => {
    const result = await send("Runtime.evaluate", { expression: `(async()=>(${expression}))()`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const navigate = async (origin: string): Promise<void> => {
    await send("Page.navigate", { url: origin });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(`location.origin === ${JSON.stringify(origin)} && typeof fingerprintFixture !== 'undefined'`)) return;
      await pause(40);
    }
    throw new Error("isolated fingerprint fixture did not load");
  };
  const secureOrigin = `http://127.0.0.1:${address.port}`;
  await navigate(secureOrigin);
  const secure = await evaluate(`({secure:isSecureContext,subtle:typeof crypto.subtle,hash:await fingerprintFixture.sha256Hex(${JSON.stringify(path + "\0" + JSON.stringify(body))})})`);
  assert.equal(secure.secure, true); assert.equal(secure.hash, expected);
  const insecureOrigin = `http://wand-crypto-review.test:${address.port}`;
  await navigate(insecureOrigin);
  const insecure = await evaluate(`({secure:isSecureContext,subtle:typeof crypto.subtle,uuid:typeof crypto.randomUUID,
    random:typeof crypto.getRandomValues,hash:await fingerprintFixture.sha256Hex(${JSON.stringify(path + "\0" + JSON.stringify(body))})})`);
  assert.deepEqual(insecure, { secure: false, subtle: "undefined", uuid: "undefined", random: "function", hash: expected });
  const rejected = await evaluate(`fingerprintFixture.repository.post(${JSON.stringify(path)},${JSON.stringify(body)}).catch(error=>({id:error.requestId,unknown:error.__wandAmbiguousDelivery}))`);
  assert.deepEqual(rejected, { id: priorId, unknown: true }); assert.equal(requests.length, 0);
  await evaluate(`fingerprintFixture.repository.reconcile(${JSON.stringify(priorId)})`);
  const unknown = await evaluate(`fingerprintFixture.repository.post(${JSON.stringify(path)},${JSON.stringify(body)}).catch(error=>({id:error.requestId,unknown:error.__wandAmbiguousDelivery}))`);
  assert.equal(unknown.unknown, true); assert.match(unknown.id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  const beforeDuplicate = requests.length;
  assert.deepEqual(await evaluate(`fingerprintFixture.repository.post(${JSON.stringify(path)},${JSON.stringify(body)}).catch(error=>({id:error.requestId,unknown:error.__wandAmbiguousDelivery}))`), unknown);
  assert.equal(requests.length, beforeDuplicate);
  await evaluate(`fingerprintFixture.repository.reconcile(${JSON.stringify(unknown.id)})`);
  mode = "accepted";
  const accepted = await evaluate(`fingerprintFixture.repository.post(${JSON.stringify(path)},${JSON.stringify(body)})`);
  assert.equal(accepted.state, "accepted"); assert.notEqual(accepted.requestId, unknown.id);
  assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem("wand-conversation-requests-v1"))'), {});
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "http-fingerprint.json"), JSON.stringify({ secure, insecure, preservedOldRequest: rejected,
      unknownDuplicateBlocked: unknown, accepted, requests, isolated: true, modelCalls: 0 }, null, 2));
  }
});
