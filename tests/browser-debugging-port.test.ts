import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { closeBrowserFixture, closeFixtureServer } from "./helpers/run-plush-avatar-browser-harness.mjs";
import { readPublishedChromePort } from "./helpers/browser-process.mjs";
import { runTestProcess } from "./helpers/test-process.js";

test("Chrome readiness waits for a fully published valid port, not just an existing empty/partial file", t => {
  const root = mkdtempSync(join(tmpdir(), "wand-chrome-port-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "DevToolsActivePort");
  assert.equal(readPublishedChromePort(file), null);
  for (const contents of ["", "12", "0\n", "65536\n", "not-ready\n"]) {
    writeFileSync(file, contents); assert.equal(readPublishedChromePort(file), null);
  }
  writeFileSync(file, "12345\n/devtools/browser/offline-fixture");
  assert.equal(readPublishedChromePort(file), "12345");
});

test("fixture shutdown closes an outstanding HTTP response before resolving", { timeout: 5_000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write("pending fixture response"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const interrupted = assert.rejects(response.text());
  await closeFixtureServer(server);
  await interrupted;
  assert.equal(server.listening, false);
});

test("a rejected browser close still releases the HTTP fixture and its temporary files", { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-browser-close-reject-"));
  const server = createServer((_req, res) => { res.writeHead(200); res.write("pending fixture response"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const interrupted = assert.rejects(response.text());
  await assert.rejects(closeBrowserFixture({ close: async () => { throw new Error("fixture browser close rejected"); } },
    server, () => rmSync(root, { recursive: true, force: true })), /fixture browser close rejected/);
  await interrupted;
  assert.equal(server.listening, false);
  assert.equal(existsSync(root), false);
});

test("an exited Chrome leader releases a diagnostic pipe inherited by its descendants", {
  timeout: 5_000, skip: process.platform === "win32",
}, async (t) => {
  const leader = `const {spawn}=require('node:child_process');
    spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore',2]});
    process.stderr.write('ready\\n');setInterval(()=>{},1000);`;
  const source = `import {spawn} from 'node:child_process';import {once} from 'node:events';
    import {stopChromeProcess} from ${JSON.stringify(new URL("./helpers/browser-process.mjs", import.meta.url).href)};
    const child=spawn(process.execPath,['-e',${JSON.stringify(leader)}],{stdio:['ignore','ignore','pipe']});
    const exited=once(child,'exit');await once(child.stderr,'data');
    await stopChromeProcess(child,exited);console.log('owned browser closed');`;
  const output = await runTestProcess({ args: ["--input-type=module", "-e", source],
    signal: t.signal, timeoutMs: 2_000, graceMs: 100 });
  assert.match(output, /owned browser closed/);
});

test("Chrome startup failure reports diagnostics and removes its owned profile", { timeout: 5_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-chrome-start-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `import assert from 'node:assert/strict';import {readdirSync} from 'node:fs';
    import {openChromeConnection} from ${JSON.stringify(new URL("./helpers/browser-process.mjs", import.meta.url).href)};
    await assert.rejects(openChromeConnection(), /Chrome exited before debugging was ready/);
    assert.deepEqual(readdirSync(process.env.TMPDIR),[]);console.log('owned startup cleanup complete');`;
  const output = await runTestProcess({ args: ["--input-type=module", "-e", source],
    env: { ...process.env, CHROME_BIN: process.execPath, TMPDIR: root }, signal: t.signal, timeoutMs: 2_000 });
  assert.match(output, /owned startup cleanup complete/);
});
