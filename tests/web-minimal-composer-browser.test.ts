import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("minimal composer preserves drafts and owned popups; PTY input and shortcuts switch as complete views", {
  skip: process.env.WAND_MINIMAL_COMPOSER_BROWSER !== "1", timeout: 240_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-minimal-composer-"));
  const output = process.env.WAND_MINIMAL_COMPOSER_OUTPUT ? resolve(process.env.WAND_MINIMAL_COMPOSER_OUTPUT) : join(root, "output/architecture-stage2/web-pty-input-modes"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import './tests/helpers/composer-panels-browser-harness';
    import {updateInteractiveControls} from './src/web-ui/browser/input';
    import {attachEventListeners} from './src/web-ui/browser/events';
        import {ptyInputState} from './src/web-ui/pty-input-state';
    import {refreshAllChatModeTrios} from './src/web-ui/browser/session-engine';
    import {PTY_SHORTCUTS} from './src/web-ui/react/composer-rail/terminal-shortcuts';
    window.minimalFixture={update:updateInteractiveControls,bind:attachEventListeners,refreshRuntime:refreshAllChatModeTrios,ptyInputState,priority:PTY_SHORTCUTS.map(k=>k.key)};
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(path === "/api/session-check" ? { authed: false } : {})); return; }
    const files: Record<string, string> = { "/app.js": join(temp, "app.js"), "/styles.css": join(root, "src/web-ui/content/styles.css"), "/tailwind.css": join(root, "src/web-ui/content/tailwind.css") };
    if (files[path]) { response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css"); response.end(readFileSync(files[path])); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#panels-source-host{display:flex;flex-direction:column;height:100dvh;width:100%}#chat-output{flex:1;min-height:0}#app{height:0}</style></head><body><script src="/app.js"></script></body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/`, 1280, 900);
  try {
    await browser.wait("!!window.composerPanels"); await browser.evaluate("window.p=window.composerPanels; p.setup()");
    await browser.evaluate("minimalFixture.bind();minimalFixture.update();window.original=document.getElementById('input-box');void 0");
    for (const [name, width, reduced] of [["desktop", 1280, false], ["phone", 390, false], ["narrow-reduced", 320, true]].filter(([name]) => !process.env.WAND_MINIMAL_VIEWPORT || name === process.env.WAND_MINIMAL_VIEWPORT) as Array<[string, number, boolean]>) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await browser.evaluate("p.state.sessions[0].sessionKind='structured';p.state.terminalInteractive=false;p.composer.edit(p.state.selectedId,{text:''});minimalFixture.update();void 0");
      await browser.click("#chat-output"); await browser.wait("document.querySelector('.input-composer').dataset.composerExpanded==='false'");
      assert.equal(await browser.evaluate("original===document.getElementById('input-box')"), true);
      await browser.evaluate("p.state.sessions[0].selectedModel='claude-opus-4-6';p.state.sessions[0].thinkingEffort='deep';minimalFixture.refreshRuntime();void 0");
      await browser.settle();
      const runtime = await browser.evaluate(`(()=>{const r=document.querySelector('.composer-inline-config'),m=r.querySelector('[data-mode-control-pill=model]'),t=r.querySelector('[data-mode-control-pill=thinking]');const box=r.getBoundingClientRect(),attach=document.getElementById('attach-btn').getBoundingClientRect();return {height:box.height,model:m.textContent,thinking:t.textContent,sameActionRow:Math.abs((box.top+box.bottom)/2-(attach.top+attach.bottom)/2)<1,floating:getComputedStyle(r).position==='absolute',modelWidth:m.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.ok(runtime.height >= 24, "model/thinking remain visible while the editor is collapsed");
      assert.equal(runtime.floating, true, "runtime labels float at the upper right without occupying the attachment/action row");
      assert.ok(runtime.modelWidth >= 60, "narrow layouts must not squeeze the model name to zero width: " + JSON.stringify({ name, ...runtime }));
      assert.match(runtime.model, /4[.-]6/);
      assert.match(runtime.thinking, /中/);
      assert.equal(runtime.overflow, false);
      await browser.screenshot(join(output, `${name}-chat-compact.png`));
      await browser.click(".composer-compact-entry");
      await browser.wait("document.activeElement===original");
      assert.ok(await browser.evaluate("document.querySelector('.composer-inline-config').getBoundingClientRect().height >= 24"));
      await browser.click("#attach-btn");
      await browser.evaluate("original.focus();void 0");
      await browser.key("Escape");
      assert.equal(await browser.evaluate("document.getElementById('attach-btn').getAttribute('aria-expanded')"), "false", "Escape closes the input's menu before acting on a session");
      assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.composerExpanded"), "true");
      await browser.click("#input-box");
      await browser.send("Input.insertText", { text: "未发送草稿\n第二行" });
      await browser.evaluate("p.composer.edit(p.state.selectedId,{text:original.value});void 0");
      assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.composerExpanded"), "true");
      // Real native input events must not republish companion/portal chrome or
      // remeasure once in the native handler and again in Sender's layout effect.
      await browser.settle();
      await browser.evaluate(`(()=>{window.typingMeasurements=0;window.companionChanges=0;
        window.originalComputedStyle=window.getComputedStyle;
        window.getComputedStyle=function(node,...args){if(node===original)typingMeasurements++;return originalComputedStyle.call(window,node,...args)};
        window.companionObserver=new MutationObserver(records=>companionChanges+=records.length);
        const companion=document.querySelector('[data-composer-avatar-host]');
        if(companion)companionObserver.observe(companion,{subtree:true,childList:true,attributes:true,characterData:true});})()`);
      for (const text of "typing0123") await browser.send("Input.insertText", { text });
      await browser.settle();
      const typing = await browser.evaluate(`(()=>{companionObserver.disconnect();window.getComputedStyle=originalComputedStyle;return {measurements:typingMeasurements,companionChanges,value:original.value,draft:p.composer.read(p.state.selectedId).text}})()`);
      assert.ok(typing.measurements <= 10, "at most one textarea measurement per native edit: " + JSON.stringify({ name, ...typing }));
      assert.equal(typing.companionChanges, 0, "typing never synchronously rerenders the identity/status tree");
      assert.equal(typing.value, "未发送草稿\n第二行typing0123");
      assert.equal(typing.draft, typing.value, "native edit and revision owner agree");
      await browser.screenshot(join(output, `${name}-chat-edit.png`));
      await browser.key("Escape"); await browser.wait("document.querySelector('.input-composer').dataset.composerExpanded==='false'");
      assert.match(await browser.evaluate("document.querySelector('.composer-compact-entry').textContent"), /草稿/);
      assert.equal(await browser.evaluate("original.value"), "未发送草稿\n第二行typing0123");
      await browser.click(".composer-compact-entry");
      // Failed delivery remains editable, and acknowledgement cannot clear newer input.
      await browser.evaluate("document.getElementById('send-input-button').dataset.phase='failed';void 0"); await browser.settle();
      await browser.click("#chat-output");
      assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.composerExpanded"), "true");
      await browser.evaluate("document.getElementById('send-input-button').dataset.phase='sent';void 0"); await browser.settle();
      assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.composerExpanded"), "true");
      await browser.evaluate("p.composer.edit(p.state.selectedId,{text:''});void 0");
      await browser.settle();
      await browser.evaluate("document.getElementById('send-input-button').dataset.phase='sent';void 0");
      await browser.wait("document.querySelector('.input-composer').dataset.composerExpanded==='false'", "accepted empty draft collapses");
      await browser.evaluate("p.state.sessions[0].sessionKind='pty';p.state.sessions[0].status='running';p.state.currentView='terminal';p.state.terminalInteractive=true;window.packets=[];p.state.ws={readyState:1,send:value=>packets.push(JSON.parse(value))};minimalFixture.update();void 0");
      await browser.settle();
      // The PTY dock rests collapsed; the keys return only when asked for.
      await browser.evaluate("minimalFixture.ptyInputState.update(p.state.selectedId,{open:false});void 0");
      await browser.wait("document.querySelector('.input-composer').dataset.ptyCollapsed==='true'", "PTY dock rests collapsed");
      await browser.click(".pty-dock-toggle");
      await browser.wait("!document.querySelector('.input-composer').dataset.ptyCollapsed", "dock expands on demand");
      await browser.evaluate("window.modeToggle=document.querySelector('.pty-input-mode-toggle');document.addEventListener('keydown',p.captureTerminalInput,true);void 0");
      const keys = await browser.evaluate(`(()=>{const t=modeToggle.getBoundingClientRect(),k=document.getElementById('terminal-shortcuts'),h=document.querySelector('.input-composer');return{mode:h.dataset.ptyInputMode,keysWidth:k.getBoundingClientRect().width,inputInert:original.closest('.composer-input-wrap').inert,keysInert:k.inert,overflow:document.documentElement.scrollWidth>innerWidth,node:original===document.getElementById('input-box'),toggle:{x:t.x,y:t.y,width:t.width,height:t.height}}})()`);
      const visible = await browser.evaluate("[...document.querySelectorAll('[data-terminal-key]')].filter(n=>!n.hidden).map(n=>n.dataset.terminalKey)");
      assert.deepEqual(visible, await browser.evaluate(`minimalFixture.priority.slice(0,${visible.length})`));
      assert.ok(visible.includes("enter"));
      assert.equal(keys.node, true); assert.equal(keys.mode, "shortcuts"); assert.equal(keys.inputInert, true); assert.equal(keys.keysInert, false); assert.equal(keys.overflow, false); assert.ok(keys.keysWidth > 80);
      await browser.screenshot(join(output, `${name}-pty-shortcuts.png`));
      // Keyboard activation of the switch must never send Enter to the PTY.
      await browser.evaluate("modeToggle.focus();void 0");
      await browser.send("Input.dispatchKeyEvent", { type:"keyDown", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, text:"\r", unmodifiedText:"\r" });
      await browser.send("Input.dispatchKeyEvent", { type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13 });
      await browser.wait("document.querySelector('.input-composer').dataset.ptyInputMode==='keyboard'");
      assert.equal(await browser.evaluate("packets.length"), 0);
      assert.equal(await browser.evaluate("document.activeElement===original"), true);
      const keyboard = await browser.evaluate(`(()=>{const t=modeToggle.getBoundingClientRect(),s=document.querySelector('.composer-surface').getBoundingClientRect(),i=original.getBoundingClientRect();return{node:modeToggle===document.querySelector('.pty-input-mode-toggle'),keysInert:document.getElementById('terminal-shortcuts').inert,inputInert:original.closest('.composer-input-wrap').inert,inputWidth:i.width,surfaceWidth:s.width,toggle:{x:t.x,y:t.y,width:t.width,height:t.height}}})()`);
      assert.equal(keyboard.node, true); assert.equal(keyboard.keysInert, true); assert.equal(keyboard.inputInert, false);
      assert.ok(keyboard.inputWidth >= keyboard.surfaceWidth - 96, "the editor owns the full writing width");
      assert.deepEqual(keyboard.toggle, keys.toggle, "the same mode button stays in place and keeps its dimensions");
      await browser.screenshot(join(output, `${name}-pty-keyboard.png`));
      await browser.click('[data-modifier="ctrl"]');
      assert.equal(await browser.evaluate("document.activeElement===original"), true, "modifier toggles preserve the editor focus");
      await browser.send("Input.insertText", {text:"a"}); await browser.send("Input.insertText", {text:"b"});
      assert.deepEqual(await browser.evaluate("packets.map(p=>p.data)"), ["\x01","\x02"]);
      assert.equal(await browser.evaluate("document.querySelector('[data-modifier=ctrl]').getAttribute('aria-pressed')"), "true");
      await browser.click('[data-modifier="shift"]');
      await browser.key("ArrowLeft");
      assert.equal(await browser.evaluate("packets.at(-1).data"), "\x1b[1;6D");
      assert.equal(await browser.evaluate("packets.length"), 3, "the physical cursor event is modified exactly once");
      await browser.click(".pty-input-mode-toggle");
      await browser.click('[data-terminal-key="left"]');
      assert.equal(await browser.evaluate("packets.at(-1).data"), "\x1b[1;6D", "Ctrl and Shift combine with the direction key");
      await browser.send("Emulation.setDeviceMetricsOverride", {width:width===1280?390:1280,height:844,deviceScaleFactor:1,mobile:false}); await browser.settle();
      assert.equal(await browser.evaluate("document.querySelector('[data-modifier=ctrl]').getAttribute('aria-pressed')"), "true");
      const resizedKeys = await browser.evaluate("[...document.querySelectorAll('[data-terminal-key]')].filter(n=>!n.hidden).map(n=>n.dataset.terminalKey)");
      assert.deepEqual(resizedKeys, await browser.evaluate(`minimalFixture.priority.slice(0,${resizedKeys.length})`));
      await browser.send("Emulation.setDeviceMetricsOverride", {width,height:844,deviceScaleFactor:1,mobile:false}); await browser.settle();
      await browser.click('[data-modifier="ctrl"]'); await browser.click(".pty-input-mode-toggle");
      await browser.send("Input.insertText", {text:"d"}); assert.equal(await browser.evaluate("packets.at(-1).data"), "D");
      await browser.click('[data-modifier="shift"]');
      await browser.evaluate("packets=[];void 0");
      // A normal PTY chat draft is preserved with its selection across mode changes.
      await browser.evaluate("p.state.terminalInteractive=false;p.state.currentView='chat';p.composer.edit(p.state.selectedId,{text:'保留这一份未发送草稿'});original.value='保留这一份未发送草稿';original.setSelectionRange(2,5);minimalFixture.update();void 0"); await browser.settle();
      await browser.click(".pty-input-mode-toggle"); await browser.click(".pty-input-mode-toggle");
      assert.equal(await browser.evaluate("original.value"), "保留这一份未发送草稿");
      assert.deepEqual(await browser.evaluate("[original.selectionStart,original.selectionEnd]"), [2,5]);
      // Simulate an IME candidate without relying on a physical input method.
      await browser.evaluate("original.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));void 0"); await browser.settle();
      assert.equal(await browser.evaluate("modeToggle.disabled"), true);
      await browser.click(".pty-input-mode-toggle"); assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.ptyInputMode"), "keyboard");
      await browser.evaluate("original.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));void 0"); await browser.settle();
      assert.equal(await browser.evaluate("modeToggle.disabled"), false);
      await browser.key("Escape"); await browser.wait("document.querySelector('.input-composer').dataset.ptyInputMode==='shortcuts'");
      assert.equal(await browser.evaluate("document.activeElement===modeToggle"), true);
      // Real shortcut dispatch uses the existing owner; UI navigation never sends packets.
      await browser.evaluate("p.state.currentView='terminal';p.state.terminalInteractive=true;minimalFixture.update();void 0"); await browser.settle();
      if (await browser.evaluate("document.querySelector('[data-terminal-key=escape]').hidden")) {
        await browser.click(".pty-extra-keys-trigger"); await browser.click('[data-extra-terminal-key="escape"]');
      } else await browser.click('[data-terminal-key="escape"]');
      assert.deepEqual(await browser.evaluate("packets.map(p=>({key:p.shortcutKey,data:p.data}))"), [{key:"escape",data:"\u001b"}]);
      await browser.evaluate("window.beforeInput=original;window.beforeToggle=modeToggle;for(let i=0;i<16;i++)modeToggle.click();void 0"); await browser.settle();
      assert.equal(await browser.evaluate("beforeInput===document.getElementById('input-box')&&beforeToggle===document.querySelector('.pty-input-mode-toggle')"), true);
      assert.equal(await browser.evaluate("document.querySelector('.input-composer').dataset.ptyInputMode"), "shortcuts");
      assert.equal(await browser.evaluate("packets.length"), 1);
      const evidence = await browser.evaluate(`(()=>{getComputedStyle(original).opacity;modeToggle.click();const host=document.querySelector('.input-composer');getComputedStyle(original).opacity;return [...host.getAnimations({subtree:true})].filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>({target:a.effect.target.className,keyframes:a.effect.getKeyframes().map(k=>({opacity:k.opacity,clipPath:k.clipPath,transform:k.transform})),duration:a.effect.getComputedTiming().duration}))})()`);
      writeFileSync(join(output, `${name}-motion.json`), JSON.stringify({ keys, keyboard, transitions: evidence }, null, 2));
      if (reduced) assert.ok(evidence.every((a: any) => a.duration <= .01), "reduced motion permits only the library's instantaneous alignment lifecycle");
      else assert.ok(evidence.length > 0, "state change produces real CSS transitions");
      await browser.settle(); await browser.key("Escape");
      await browser.evaluate("minimalFixture.ptyInputState.update(p.state.selectedId,{mode:'shortcuts',open:false,ctrl:false,shift:false});document.removeEventListener('keydown',p.captureTerminalInput,true);p.state.ws=null;p.state.currentView='chat';void 0");
    }
    assert.deepEqual(browser.errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(temp, { recursive: true, force: true }); }
});
