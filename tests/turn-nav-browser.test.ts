import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Opt-in only because Chrome is a host dependency; with opt-in every assertion executes.
test("production ordinary and IM navigation preserves reading, identity, preview and dismiss semantics", {
  skip: process.env.WAND_CHAT_NAV_BROWSER !== "1", timeout: 600_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-turn-nav-"));
  const output = process.env.WAND_CHAT_NAV_EVIDENCE_DIR || join(root, "output/chat-ux-batch1/navigation-browser");
  mkdirSync(output, { recursive: true });
  await build({ entryPoints: [join(root, "tests/helpers/turn-nav-browser-harness.tsx")], bundle: true,
    platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' } });
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.test").pathname;
    const files: Record<string, [string, string]> = { "/app.js": [join(temp, "app.js"), "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
      "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
    if (files[path]) { res.setHeader("Content-Type", files[path][1]); res.end(readFileSync(files[path][0])); return; }
    if (path.startsWith("/api/")) { requests.push(req.method + " " + path); res.setHeader("Content-Type", "application/json"); res.end('{}'); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">
      <style>body{margin:0}#chat-output{height:620px;display:flex;position:relative}.chat-messages{overflow:auto}
      #im-scroll{height:620px;overflow:auto;position:relative}#im-scroll[hidden],#chat-output[hidden]{display:none}
      #outside{height:44px}#input-box{height:44px;width:95%}</style>
      <div id="chat-output"></div><div id="im-scroll" class="conversation-message-scroll" hidden><div id="im-root"></div></div>
      <button id="outside">外部控件</button><textarea id="input-box">保留的草稿</textarea><script src="/app.js"></script></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await openBrowser("about:blank", 1280, 900);
  t.after(async () => { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); });
  const cases: unknown[] = [];
  const allModes = ["desktop", "390px", "native-shell", "reactUi=0", "reduced-motion", "390px-native-reduced"];
  const modes = process.env.WAND_CHAT_NAV_MODES?.split(",") ?? allModes;
  assert.ok(modes.length && modes.every(mode => allModes.includes(mode)), "matrix modes must name supported cases");
  const turns = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", uuid: `turn-${index}`, messageId: `turn-${index}`,
    content: [{ type: "text", text: index === 4 ? '{"user":"JSON正文","items":[1,2]}'
      : index === 6 ? "[附件已上传，请查看以下文件:\n/tmp/PRIVATE_ATTACHMENT.txt\n]\n附件后的可见问题"
      : `正文_${index}\n${"真实正文阅读行\n".repeat(index % 2 ? 8 : 2)}` }] }));
  const e = (source: string) => browser.evaluate(source);
  const directory = '[role="navigation"][aria-label="提问目录"]';
  const closed = async (focus?: string) => {
    // Ant retains the portal while its exit motion finishes. Assert the settled
    // user-visible state, not synchronous physical node removal.
    await browser.wait(`!Array.from(document.querySelectorAll('${directory}')).some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')`);
    assert.equal(await e("Array.from(document.querySelectorAll('.turn-nav-trigger')).some(node => node.getAttribute('aria-expanded') === 'true')"), false);
    if (focus) assert.equal(await e(`document.activeElement.matches(${JSON.stringify(focus)})`), true);
  };
  const trigger = () => browser.click('#chat-output:not([hidden]) .turn-nav-trigger, #im-scroll:not([hidden]) .turn-nav-trigger');
  const entries = () => e(`Array.from(document.querySelectorAll('${directory} .turn-nav-entry')).map(n=>({owner:n.dataset.turnNavOwner,text:n.querySelector('.turn-nav-preview').textContent,current:n.getAttribute('aria-current')}))`);
  const visibleTarget = (attribute: string, owner: string) => e(`(()=>{const root=document.querySelector('#chat-output:not([hidden]) .chat-messages, #im-scroll:not([hidden])');const n=Array.from(root.querySelectorAll('[${attribute}]')).find(n=>n.getAttribute('${attribute}')===${JSON.stringify(owner)});if(!n)return false;const r=n.getBoundingClientRect(),v=root.getBoundingClientRect();return r.height>0&&r.top>=v.top-1&&r.top<v.bottom&&document.activeElement===n})()`);
  const clickOwner = (owner: string) => browser.click(`${directory} [data-turn-nav-owner=${JSON.stringify(owner)}]`);
  try {
    for (const mode of modes) {
      const narrow = mode.startsWith("390px");
      await browser.send("Emulation.setDeviceMetricsOverride", { width: narrow ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode.includes("reduced") ? "reduce" : "no-preference" }, { name: "pointer", value: narrow ? "coarse" : "fine" }] });
      await e("window.previousDocument=true");
      await browser.send("Page.navigate", { url: origin + (mode === "reactUi=0" ? "/?reactUi=0" : "/") });
      await browser.wait("!window.previousDocument && !!window.navigationHarness");
      if (mode.includes("native")) await e("document.documentElement.classList.add('is-wand-app');window.__wandIosNative=true");
      await e(`window.n=navigationHarness;window.fixtureTurns=${JSON.stringify(turns)};n.ordinary(fixtureTurns,{},8)`);
      await browser.wait("!!document.querySelector('#chat-output .turn-nav-trigger')");
      assert.equal(await e("getComputedStyle(document.querySelector('.chat-messages')).flexDirection"), "column-reverse");
      assert.equal(await e("!!document.querySelector('[data-msg-index=\"0\"]')"), false, `${mode}: earlier local target initially unmounted`);
      await trigger();
      const ordinary = await entries(); assert.equal(ordinary.length, 20);
      assert.equal(ordinary[2].text, '{"user":"JSON正文","items":[1,2]}');
      assert.equal(ordinary[3].text, "附件后的可见问题");
      assert.equal(ordinary.some((entry: any) => entry.text.includes("PRIVATE_ATTACHMENT")), false);
      await clickOwner(ordinary[0].owner);
      await closed();
      assert.equal(await visibleTarget("data-chat-owner", ordinary[0].owner), true, `${mode}: local target revealed, focused and positioned`);
      assert.equal(await e("n.h.state.chatStickToBottom"), false);
      await trigger();
      assert.equal((await entries()).find((entry: any) => entry.current === "location")?.owner, ordinary[0].owner, `${mode}: reading marker follows viewport rather than final assistant`);
      await browser.key("Escape");
      await closed(".turn-nav-trigger");
      await trigger(); await browser.click("#outside");
      await closed("#outside");
      await e(`window.beforeOwner=${JSON.stringify(ordinary[0].owner)};n.publish([{role:'user',uuid:'older',messageId:'older',content:[{type:'text',text:'更早前插'}]}].concat(fixtureTurns))`);
      await trigger();
      const prepended = await entries();
      assert.equal(prepended[1].owner, ordinary[0].owner, "stable render ID survives prepend");
      await clickOwner(ordinary[0].owner);
      await closed();
      assert.equal(await visibleTarget("data-chat-owner", ordinary[0].owner), true);
      const stream = await e(`(async()=>{const root=document.querySelector('.chat-messages');root.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));root.scrollTop-=200;root.dispatchEvent(new Event('scroll'));await n.h.frames();const node=Array.from(root.querySelectorAll('[data-chat-owner]')).find(x=>{const r=x.getBoundingClientRect(),v=root.getBoundingClientRect();return r.bottom>v.top+10&&r.top<v.bottom});window.readingNode=node;const before=node.getBoundingClientRect().top;const next=n.h.turns().map((t,i,a)=>i===a.length-1?{...t,content:[{type:'text',text:'流式追加\\n'.repeat(70)}]}:t);await n.publish(next);return{delta:readingNode.getBoundingClientRect().top-before,following:n.h.state.chatStickToBottom,scroll:root.scrollTop}})()`);
      assert.equal(stream.following, false); assert.ok(Math.abs(stream.delta) <= 1, `${mode}: ordinary stream preserves reading anchor ${JSON.stringify(stream)}`);
      // Source-coordinate fallback rotates when the loaded window moves, so an old owner cannot target another row.
      await e("n.ordinary([{role:'user',content:[{type:'text',text:'旧窗口问题'}]}],{messageOffset:100})");
      await trigger(); const old = (await entries())[0].owner; await browser.key("Escape");
      await e("n.publish([{role:'user',content:[{type:'text',text:'新窗口不同问题'}]}],{messageOffset:200})");
      await trigger(); assert.notEqual((await entries())[0].owner, old); await browser.key("Escape");
      assert.equal(await e(`n.jumpToChatTurn(document.querySelector('.chat-messages'),${JSON.stringify(old)},'data-chat-owner')`), false);

      await e("n.im(fixtureTurns,'im-A')");
      await browser.wait("!!document.querySelector('#im-scroll .turn-nav-trigger')");
      assert.notEqual(await e("getComputedStyle(document.querySelector('.conversation-stream')).flexDirection"), "column-reverse");
      await trigger(); const im = await entries(); assert.equal(im.length, 20);
      assert.equal(im[2].text, '{"user":"JSON正文","items":[1,2]}');
      await clickOwner(im[2].owner);
      await closed();
      assert.equal(await visibleTarget("data-conversation-nav-owner", im[2].owner), true);
      assert.equal(await e(`document.querySelector('[data-presentation-id="turn-4"]').textContent.includes('JSON正文')`), true);
      await trigger(); assert.equal((await entries()).find((entry: any) => entry.current === "location")?.owner, im[2].owner);
      await browser.key("Escape");
      await e("window.imTurns=[{role:'user',messageId:'im-old',content:[{type:'text',text:'更早IM问题'}]}].concat(fixtureTurns);n.im(imTurns,'im-A')");
      await trigger(); assert.equal((await entries())[3].owner, im[2].owner); await clickOwner(im[2].owner);
      const imStream = await e(`(async()=>{const scroll=document.getElementById('im-scroll');const before=scroll.scrollTop;await n.im(imTurns.map((t,i,a)=>i===a.length-1?{...t,content:[{type:'text',text:'IM流式输出\\n'.repeat(120)}]}:t),'im-A');return{before,after:scroll.scrollTop,away:scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop}})()`);
      assert.ok(Math.abs(imStream.after - imStream.before) <= 1, `${mode}: IM stream does not jump to tail`); assert.ok(imStream.away > 200);
      await trigger(); await browser.key("Escape");
      await closed(".turn-nav-trigger");
      await trigger(); await browser.click("#outside"); await closed("#outside");
      await e("n.im([{role:'user',content:[{type:'text',text:'legacy A'}]}],'legacy')");
      await trigger(); const legacy = (await entries())[0].owner; await browser.key("Escape");
      await e("n.im([{role:'user',content:[{type:'text',text:'legacy B'}]}],'legacy')");
      await trigger(); assert.notEqual((await entries())[0].owner, legacy, `${mode}: IM legacy index is not reused for a different window`); await browser.key("Escape");
      assert.equal(await e(`n.jumpToChatTurn(document.getElementById('im-scroll'),${JSON.stringify(legacy)},'data-conversation-nav-owner')`), false);
      await e("window.legacyTurns=[{role:'user',content:[{type:'text',text:'无ID旧提问'}]},{role:'assistant',content:[{type:'text',text:'既有长回复\\n'.repeat(100)}]}];n.im(legacyTurns,'legacy-clones')");
      await trigger(); const cloneOwner = (await entries())[0].owner; await browser.key("Escape"); await closed();
      const clones = await e(`(async()=>{const root=document.getElementById('im-scroll');const row=root.querySelector('[data-presentation-id]');root.scrollTop=200;root.dispatchEvent(new Event('scroll'));await n.h.frames();const before=root.scrollTop;await n.im(JSON.parse(JSON.stringify(legacyTurns)),'legacy-clones');return{sameRow:row===root.querySelector('[data-presentation-id]'),before,after:root.scrollTop}})()`);
      assert.equal(clones.sameRow, true, "identical HTTP snapshots keep legacy message DOM");
      assert.ok(Math.abs(clones.after - clones.before) <= 1, "cloned legacy history does not become new arrivals");
      await trigger(); assert.equal((await entries())[0].owner, cloneOwner); await browser.key("Escape"); await closed();
      await trigger(); await e("n.im(fixtureTurns,'different-conversation')");
      await closed();
      assert.equal(await e("document.getElementById('input-box').value"), "保留的草稿");
      assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1"), true);
      await browser.screenshot(join(output, `${mode}.png`));
      cases.push({ mode, ordinary: { direction: "reverse", questions: 20, localWindowSeek: true, stablePrepend: true, stream }, im: { direction: "forward", questions: 20, stablePrepend: true, imStream, cloneSnapshotPreserved: true }, dismiss: ["selection", "outside", "Escape", "scope"], staleOwnersRejected: true, jsonBodyPreserved: true });
      writeFileSync(join(output, "progress.json"), JSON.stringify({ completedModes: cases, expectedModes: modes }, null, 2));
    }
    assert.deepEqual(browser.errors, []);
    assert.equal(requests.some(request => !request.startsWith("GET ")), false, "no model or mutation requests");
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, cases, errors: browser.errors, requests }, null, 2));
  } catch (error) {
    writeFileSync(join(output, "failure.json"), JSON.stringify({ error: String(error), cases, errors: browser.errors, requests,
      dom: await e("document.body.innerText.slice(0,5000)").catch(String) }, null, 2));
    await browser.screenshot(join(output, "failure.png")).catch(() => {});
    throw error;
  }
});
