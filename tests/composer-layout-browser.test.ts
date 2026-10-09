// Production composer owners in isolated Chrome; synthetic HTTP never invokes an AI or installed service.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("integrated composer preserves native nodes, bounded drafts, attachment actions and focused editing across viewport sizes", {
  skip: process.env.WAND_COMPOSER_LAYOUT_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-composer-layout-"));
  const output = resolve(root, process.env.WAND_COMPOSER_LAYOUT_OUTPUT || "output/sidebar-refinement/composer-integration");
  mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import "./tests/helpers/composer-panels-browser-harness";
    import { mountComposerSurfaces } from "./src/web-ui/browser/composer-surface-adapter";
    import { mountComposerSender } from "./src/web-ui/browser/composer-sender-adapter";
    import { syncBrowserComposerAttachments } from "./src/web-ui/browser/composer-attachments-adapter";
    const resize=input=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,160)+'px';};
    window.fixture={mount:()=>{mountComposerSurfaces();mountComposerSender(resize);},
      attachments:()=>syncBrowserComposerAttachments({resolve:()=>[{index:0,name:'很长的设计交付文件名称-'+('商业产品'.repeat(15))+'.pdf',sizeLabel:'12 KB',previewUrl:null}],onRemove:()=>{window.removed=(window.removed||0)+1;syncBrowserComposerAttachments({resolve:()=>[],onRemove:()=>{}});}}),
      resize};
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  let requests = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) { requests++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(path === "/api/session-check" ? { authed: false } : {})); return; }
    const files: Record<string, [string, string]> = { "/app.js": [join(temp, "app.js"), "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"], "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
    if (files[path]) { response.setHeader("Content-Type", files[path][1]); response.end(readFileSync(files[path][0])); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>
      #panels-source-host{display:flex;flex-direction:column;height:100dvh;width:100%;background:var(--bg-primary)}#chat-output{display:flex;flex:1;min-height:0}#app{height:0}
      .chat-messages{padding:20px var(--wand-page-inset,20px)}
      </style></head><body><script src="/app.js"></script></body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/`, 1280, 900);
  const cases: any[] = [];
  try {
    await browser.wait("!!window.composerPanels");
    await browser.evaluate("window.p=window.composerPanels;p.setup()");
    await browser.evaluate("fixture.mount();window.originalInput=document.getElementById('input-box');window.nativeEdits=0;originalInput.addEventListener('input',()=>nativeEdits++);window.originalActions=document.getElementById('send-input-button');void 0");
    for (const [name, width, height, reduce] of [["desktop", 1280, 900, false], ["tablet", 768, 900, false], ["phone", 390, 844, false], ["narrow", 320, 640, true], ["zoom-equivalent", 640, 450, true]] as const) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: name === "zoom-equivalent" ? 2 : 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] });
      await browser.evaluate("p.composer.edit(p.state.selectedId,{text:''});fixture.mount();document.activeElement?.blur();void 0");
      await browser.settle();
      await browser.screenshot(join(output, `${name}-empty.png`));
      await browser.click("#input-box");
      await browser.send("Input.insertText", { text: "输入区与消息自然衔接。" });
      // Synthetic draft publication models the same projection as the native edit owner.
      await browser.evaluate("p.composer.edit(p.state.selectedId,{text:originalInput.value});fixture.mount();void 0");
      const focus = await browser.evaluate(`(()=>{const s=document.querySelector('.composer-surface'),i=originalInput,t=document.querySelector('.ant-sender'),r=s.getBoundingClientRect(),b=getComputedStyle(s);return{nodeIdentity:i===document.getElementById('input-box'),actionIdentity:originalActions===document.getElementById('send-input-button'),focus:document.activeElement===i,nativeEdits,inside:r.left>=0&&r.right<=innerWidth,inputLeft:i.getBoundingClientRect().left-s.getBoundingClientRect().left,surfaceShadow:b.boxShadow,surfaceBackground:b.backgroundColor,surfaceBorder:b.borderTopWidth,senderBorder:getComputedStyle(t).borderTopWidth,senderShadow:getComputedStyle(t).boxShadow,text:i.value,focusLine:b.borderTopColor,caret:getComputedStyle(i).caretColor}})()`);
      assert.equal(focus.nodeIdentity, true); assert.equal(focus.actionIdentity, true); assert.equal(focus.focus, true); assert.ok(focus.nativeEdits > 0); assert.equal(focus.inside, true);
      assert.equal(focus.senderBorder, "0px"); assert.equal(focus.senderShadow, "none");
      if (process.env.WAND_COMPOSER_LAYOUT_BASELINE !== "1") { assert.equal(focus.surfaceShadow, "none"); assert.equal(focus.surfaceBackground, "rgba(0, 0, 0, 0)"); assert.ok(focus.inputLeft < 1); assert.equal(focus.focusLine, focus.caret); }
      await browser.screenshot(join(output, `${name}-focus.png`));
      await browser.evaluate(`p.composer.edit(p.state.selectedId,{text:${JSON.stringify(("长文本没有空格LongUnbrokenContent".repeat(18) + "\n").repeat(12))}});fixture.mount();void 0`);
      const long = await browser.evaluate("({text:originalInput.value.length,height:originalInput.offsetHeight,scroll:originalInput.scrollHeight>originalInput.clientHeight,inside:originalInput.getBoundingClientRect().right<=innerWidth})");
      assert.ok(long.text > 1000); assert.ok(long.height <= 160); assert.equal(long.scroll, true); assert.equal(long.inside, true);
      await browser.screenshot(join(output, `${name}-long.png`));
      await browser.evaluate("window.disabledClickCount=0;originalActions.addEventListener('click',()=>disabledClickCount++,{once:true});originalActions.disabled=true;originalInput.disabled=true;void 0");
      await browser.click("#send-input-button");
      const disabled = await browser.evaluate("({inputDisabled:originalInput.disabled,actionDisabled:originalActions.disabled,clicks:disabledClickCount,draft:originalInput.value,cursor:getComputedStyle(originalInput).cursor})");
      assert.equal(disabled.inputDisabled, true); assert.equal(disabled.actionDisabled, true); assert.equal(disabled.clicks, 0); assert.equal(disabled.cursor, "not-allowed"); assert.ok(disabled.draft.length > 1000);
      await browser.screenshot(join(output, `${name}-disabled.png`));
      await browser.evaluate("originalActions.disabled=false;originalInput.disabled=false;void 0");
      await browser.evaluate("fixture.attachments();void 0");
      await browser.wait("!!document.querySelector('[aria-label^=\"移除附件 \" ]')", "attachment keyboard affordance");
      const attachment = await browser.evaluate("({width:document.documentElement.scrollWidth,viewport:innerWidth,label:document.querySelector('[aria-label^=\"移除附件 \" ]').getAttribute('aria-label')})");
      assert.ok(attachment.width <= attachment.viewport + 1, "long attachment stays contained");
      await browser.screenshot(join(output, `${name}-attachment.png`));
      await browser.evaluate("document.querySelector('[aria-label^=\"移除附件 \" ]').focus();void 0"); await browser.key("Enter");
      await browser.wait("!document.querySelector('[aria-label^=\"移除附件 \" ]')", "attachment removed once");
      assert.equal(await browser.evaluate("removed"), cases.length + 1);
      await browser.evaluate("p.state.sessions[0].sessionKind='pty';fixture.mount();p.state.sessions[0].sessionKind='structured';fixture.mount();fixture.mount();void 0");
      assert.equal(await browser.evaluate("originalInput===document.getElementById('input-box')&&originalActions===document.getElementById('send-input-button')"), true, "Sender mount/unmount preserves native textarea and action hosts");
      cases.push({ name, width, height, reducedMotion: reduce, focus, long, disabled, attachment, mountedWithoutIdentityLoss: true });
    }
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "browser.json"), JSON.stringify({ evidence: "Isolated Chrome with production owners, equivalent zoom only; no installed acceptance or physical keyboard", cases, requests, errors: browser.errors }, null, 2));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(temp, { recursive: true, force: true }); }
});
