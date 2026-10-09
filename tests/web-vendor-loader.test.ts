import assert from "node:assert/strict";
import test from "node:test";
import { ensureQrCodeLibrary, ensureTerminalLibrary } from "../src/web-ui/vendor-loader.js";

test("optional browser libraries share downloads, validate registration and permit explicit retry", async t => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = new Map(["document", "QRCodeLib", "XTermLib"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  });
  const scripts: Array<{ src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null; removed: boolean; remove(): void }> = [];
  let hasAddress = true;
  globals.document = {
    querySelector: (selector: string) => hasAddress ? { content: selector.includes("qrcode") ? "/vendor/qrcode/qrcode.bundle.js?v=qr-hash" : "/vendor/xterm/xterm.bundle.js?v=term-hash" } : null,
    createElement: () => ({ src: "", async: false, onload: null, onerror: null, removed: false, remove() { this.removed = true; } }),
    head: { appendChild: (script: typeof scripts[number]) => scripts.push(script) },
  };
  delete globals.QRCodeLib; delete globals.XTermLib;

  const first = ensureQrCodeLibrary(), second = ensureQrCodeLibrary();
  assert.equal(scripts.length, 1, "concurrent consumers must share one script");
  assert.equal(scripts[0]!.src, "/vendor/qrcode/qrcode.bundle.js?v=qr-hash");
  globals.QRCodeLib = { toCanvas() {} };
  scripts[0]!.onload!();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  await ensureQrCodeLibrary();
  assert.equal(scripts.length, 1, "successful registration is reused without another download");

  const failed = ensureTerminalLibrary();
  scripts[1]!.onerror!();
  await assert.rejects(failed, /加载失败/);
  assert.equal(scripts[1]!.removed, true);
  const retry = ensureTerminalLibrary();
  assert.equal(scripts.length, 3, "a failed request can be explicitly retried");
  scripts[2]!.onload!();
  await assert.rejects(retry, /加载未完成/, "onload alone is not successful library registration");

  const registered = ensureTerminalLibrary();
  globals.XTermLib = { Terminal: class {}, FitAddon: class {} };
  scripts[3]!.onload!(); await registered;
  await ensureTerminalLibrary(); assert.equal(scripts.length, 4);
  delete globals.XTermLib; hasAddress = false;
  await assert.rejects(ensureTerminalLibrary(), /刷新页面/);
  assert.equal(scripts.length, 4, "a missing versioned address must not request a guessed URL");
});
