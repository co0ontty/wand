import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";
import { EMBEDDED_WEB_ASSETS } from "../src/web-ui/embedded-assets.js";
import { peopleContrastExpression } from "./helpers/people-layout-contrast.js";
import { WAND_PALETTES } from "../src/web-ui/react/theme-palettes.js";

test("theme switching preserves live native editing, terminal buffers, overlays and local preference recovery", {
  skip: process.env.WAND_THEME_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-theme-browser-"));
  const output = join(root, process.env.WAND_THEME_BROWSER_OUTPUT ?? "output/theme-palettes"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import "./tests/helpers/composer-panels-browser-harness";
    import { mountComposerSender } from "./src/web-ui/browser/composer-sender-adapter";
    import { SettingsHost } from "./src/web-ui/react/settings/host";
    import { settingsController } from "./src/web-ui/react/settings/controller";
    import { setWandTheme } from "./src/web-ui/react/theme-preference";
    import { createPooledTerminal, writePooledTerminal, disposeAllPooledTerminals } from "./src/web-ui/browser/terminal-pool";
    import { buildMessagesForRender } from "./src/web-ui/browser/input";
    import { doRenderChat } from "./src/web-ui/browser/chat-render";
    const resize=input=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,160)+'px';};
    const settings=document.createElement("div");settings.id="theme-settings";settings.hidden=true;document.body.appendChild(settings);
    createRoot(settings).render(<SettingsHost/>);
    window.themeFixture={setTheme:setWandTheme, mount:()=>mountComposerSender(resize),
      settings(open){settings.hidden=!open;document.getElementById("panels-source-host").hidden=open;
        if(open)settingsController.open("display");else settingsController.close();},
      chat(){const p=window.composerPanels,s=p.state.sessions[0];s.status="completed";s.structuredState={inFlight:false};
        s.messages=[{role:"user",uuid:"theme-u",content:[{type:"text",text:"整理侧边栏交互，让导航与会话更紧凑清楚。"}]},
        {role:"assistant",uuid:"theme-a",content:[{type:"text",text:"已整理导航层级与会话列表，保留名称、状态和常用操作。下一步核验长名称、搜索和键盘焦点。"}]}];
        s.messageTotal=s.messages.length;p.state.currentMessages=buildMessagesForRender(s,s.messages);doRenderChat(false);},
      terminal(){const Library=XTermLib,Original=Library.Terminal;XTermLib={...Library,Terminal:class extends Original{constructor(options){super(options);window.actualThemeTerminal=this}}};
        const host=document.createElement("div");host.id="theme-terminal";host.style.cssText="width:640px;height:200px";document.body.appendChild(host);
        const mounted=createPooledTerminal("theme-local-terminal",host);writePooledTerminal("theme-local-terminal","Theme buffer survives\\r\\n".repeat(80));return mounted;},
      dispose:disposeAllPooledTerminals};
  ` }, bundle: true, jsx:"automatic", platform: "browser", format: "iife", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const config = { host:"127.0.0.1",port:0,https:false,defaultMode:"default",defaultCwd:"/tmp",shell:"/bin/zsh",language:"",inheritEnv:true,
    defaultProvider:"claude",defaultThinkingEffort:"off",defaultModel:"",defaultCodexModel:"",defaultPiModel:"",modelGroups:[],commandPresets:[],
    cardDefaults:{editCards:false,inlineTools:false,terminal:false,thinking:false},taskRetention:{autoArchiveEnabled:false,autoArchiveDays:7,autoDeleteEnabled:false,autoDeleteDays:30},userProfile:{name:"",avatar:""} };
  const apiRequests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) {
      apiRequests.push(`${request.method} ${path}`);response.setHeader("Content-Type","application/json");
      const payload = path === "/api/settings" || path === "/api/settings/about" ? {packageName:"Wand · 本地验证",version:"4.89.0",nodeVersion:"24.21.0",updateChannel:"stable",build:{},config,desiredConfig:config,activeConfig:config,githubConnector:{connected:false},autoUpdate:{},openRouter:{configured:false,modelCount:0,lastError:null}}
        : path === "/api/models" ? {models:[],codexModels:[],freeModels:[],piModels:[]}
        : path === "/api/silicon-employees" ? {employees:[]} : path === "/api/tasks" ? {groups:[]}
        : path === "/api/conversations" ? {conversations:[]} : path === "/api/session-check" ? {authed:false} : {};
      response.end(JSON.stringify(payload));return;
    }
    if (path === "/theme.js") { response.setHeader("Content-Type","application/javascript");response.end(EMBEDDED_WEB_ASSETS.themePreloadJs);return; }
    const files: Record<string, [string,string]> = { "/app.js":[join(temp,"app.js"),"text/javascript"],
      "/styles.css":[join(root,"src/web-ui/content/styles.css"),"text/css"],"/tailwind.css":[join(root,"src/web-ui/content/tailwind.css"),"text/css"],
      "/xterm.js":[join(root,"src/web-ui/content/vendor/xterm/xterm.bundle.js"),"text/javascript"],"/xterm.css":[join(root,"src/web-ui/content/vendor/xterm/xterm.css"),"text/css"] };
    if (files[path]) {response.setHeader("Content-Type",files[path][1]);response.end(readFileSync(files[path][0]));return;}
    response.setHeader("Content-Type","text/html;charset=utf-8");
    response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/theme.js"></script><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/xterm.css"><style>
      #panels-source-host{display:flex;flex-direction:column;height:100dvh;width:100%;background:var(--bg-primary)}#panels-source-host[hidden],#theme-settings[hidden]{display:none}#chat-output{display:flex;flex:1;min-height:0}#app{height:0}#theme-settings{height:100dvh}.chat-messages{padding:20px var(--wand-page-inset,20px)}#theme-terminal{position:fixed;bottom:0;left:-2000px}
      </style></head><body><script src="/xterm.js"></script><script src="/app.js"></script></body></html>`);
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address && typeof address!=="string");
  const origin=`http://127.0.0.1:${address.port}`;
  const browser=await openBrowser(origin,1440,960);
  const cases: any[] = [];
  try {
    await browser.wait("!!window.themeFixture&&!!window.composerPanels");
    await browser.evaluate("window.p=composerPanels;p.setup()");
    await browser.evaluate("themeFixture.mount();themeFixture.chat();window.originalInput=document.getElementById('input-box');void 0");
    await browser.evaluate("p.composer.edit(p.state.selectedId,{text:'未发送的草稿：保留选择与光标。'.repeat(80)});void 0");
    await browser.settle();
    assert.equal(await browser.evaluate("themeFixture.terminal()"),true);
    await browser.wait("!!window.actualThemeTerminal&&actualThemeTerminal.buffer.active.length>40");
    await browser.evaluate("actualThemeTerminal.scrollToLine(12);actualThemeTerminal.select(0,12,5);window.termBefore={node:document.querySelector('#theme-terminal .xterm'),scroll:actualThemeTerminal.buffer.active.viewportY,selection:actualThemeTerminal.getSelection(),line:actualThemeTerminal.buffer.active.getLine(12).translateToString()};originalInput.focus();void 0");
    for (const palette of WAND_PALETTES) {
      await browser.settle();
      await browser.evaluate("originalInput.focus();originalInput.setSelectionRange(4,12);originalInput.scrollTop=60;window.editorBefore={text:originalInput.value,start:originalInput.selectionStart,end:originalInput.selectionEnd,scroll:originalInput.scrollTop,session:p.state.selectedId};void 0");
      await browser.evaluate(`themeFixture.setTheme(${JSON.stringify(palette.id)});void 0`);await browser.settle();
      const state=await browser.evaluate(`({id:document.documentElement.dataset.wandTheme,identity:originalInput===document.getElementById('input-box'),focus:document.activeElement===originalInput,text:originalInput.value,start:originalInput.selectionStart,end:originalInput.selectionEnd,scroll:originalInput.scrollTop,session:p.state.selectedId,terminal:{identity:termBefore.node===document.querySelector('#theme-terminal .xterm'),scroll:actualThemeTerminal.buffer.active.viewportY,selection:actualThemeTerminal.getSelection(),line:actualThemeTerminal.buffer.active.getLine(12).translateToString(),background:actualThemeTerminal.options.theme.background},sheets:document.querySelectorAll('#wand-theme-tokens').length})`);
      assert.equal(state.id,palette.id);assert.equal(state.identity,true);assert.equal(state.focus,true);assert.equal(state.sheets,1);
      const before=await browser.evaluate("editorBefore");for(const key of ["text","start","end","scroll","session"])assert.equal(state[key],before[key],`${palette.id} ${key}`);
      const terminal=await browser.evaluate("({scroll:termBefore.scroll,selection:termBefore.selection,line:termBefore.line})");
      assert.equal(state.terminal.identity,true);for(const key of ["scroll","selection","line"])assert.equal(state.terminal[key],terminal[key]);assert.equal(state.terminal.background,palette.terminal);
      await browser.evaluate("themeFixture.settings(true);void 0");await browser.wait("!!document.querySelector('.wand-theme-picker input:checked')");
      assert.equal(await browser.evaluate("document.querySelector('.wand-theme-picker input:checked').value"),palette.id);
      const contrast=await browser.evaluate(peopleContrastExpression([".wand-settings-library-panel-heading h2", ".wand-settings-library-panel-heading p", ".wand-theme-choice-label", ".ant-radio-wrapper-checked .wand-theme-choice-status", ".wand-settings-library-section .ant-card-head-title", ".wand-settings-library-save-bar .ant-btn-primary"]));
      assert.ok(contrast.length>=8);for(const sample of contrast)assert.ok(sample.ratio>=4.5, `${palette.id} ${sample.selector}: ${sample.ratio}`);
      await browser.screenshot(join(output,`preview-${palette.id}.png`));
      for (const [name,width,height,scale,reduce] of [["desktop",1440,960,1,false],["narrow",320,640,1,true],["200-percent-equivalent",640,480,2,false]] as const) {
        await browser.send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:scale,mobile:false});
        await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:reduce?"reduce":"no-preference"}]});await browser.settle();
        const geometry=await browser.evaluate("({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,choices:[...document.querySelectorAll('.wand-theme-choice')].map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height}})})");
        assert.equal(geometry.overflow,false);assert.equal(geometry.choices.length,5);for(const r of geometry.choices){assert.ok(r.left>=0&&r.right<=width);assert.ok(r.height>=44);}
        cases.push({theme:palette.id,layout:name,geometry,contrast,preserved:state});
        if(name!=="desktop")await browser.screenshot(join(output,`${palette.id}-${name}.png`));
      }
      await browser.send("Emulation.setDeviceMetricsOverride",{width:1440,height:960,deviceScaleFactor:1,mobile:false});
      await browser.evaluate("themeFixture.settings(false);originalInput.focus();void 0");
    }
    // Radio group uses real arrow-key selection, maintains focus and persists immediately.
    await browser.evaluate("themeFixture.setTheme('warm');themeFixture.settings(true);void 0");await browser.wait("!!document.querySelector('.wand-theme-picker input[value=warm]')");
    await browser.evaluate("document.querySelector('.wand-theme-picker input[value=warm]').focus();void 0");await browser.key("ArrowRight");
    await browser.wait("document.documentElement.dataset.wandTheme==='blue'");
    assert.equal(await browser.evaluate("document.activeElement.value"),"blue");assert.equal(await browser.evaluate("localStorage.getItem('wand-theme')"),"blue");
    await browser.key("Tab");assert.notEqual(await browser.evaluate("document.activeElement.name"),"wand-theme");
    await browser.evaluate("window.nativeSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error('denied')};void 0");
    await browser.click(".wand-theme-picker input[value=forest]");await browser.wait("!!document.querySelector('.wand-theme-picker').parentElement.innerText.includes('浏览器未允许保存')");
    assert.equal(await browser.evaluate("document.documentElement.dataset.wandTheme"),"forest");
    await browser.evaluate("Storage.prototype.setItem=nativeSet;themeFixture.setTheme('graphite');themeFixture.settings(false);void 0");
    await browser.evaluate("p.dialog('confirm');void 0");await browser.wait("!!document.querySelector('[role=dialog]')");
    await browser.evaluate("themeFixture.setTheme('mauve');void 0");await browser.key("Escape");
    await browser.wait("![...document.querySelectorAll('[role=dialog]')].some(n=>n.getClientRects().length)");
    // A real same-origin second window delivers storage events (the profile is disposable).
    await browser.evaluate("window.preferencePeer=window.open('/peer','theme-peer');void 0");await browser.wait("!!preferencePeer?.localStorage");
    await browser.evaluate("preferencePeer.localStorage.setItem('wand-theme','graphite');void 0");await browser.wait("document.documentElement.dataset.wandTheme==='graphite'");
    await browser.evaluate("preferencePeer.close();themeFixture.dispose();void 0");
    await browser.send("Page.navigate",{url:origin});await browser.wait("document.documentElement.dataset.wandTheme==='graphite'&&!!window.themeFixture");
    assert.equal(await browser.evaluate("localStorage.getItem('wand-theme')"),"graphite");
    assert.deepEqual(browser.errors,[]);assert.ok(apiRequests.every(p=>p.startsWith("GET ")),"no business mutations or AI dispatch");
    writeFileSync(join(output,"switch-browser.json"),JSON.stringify({evidence:"Actual production components and xterm in isolated Chrome; synthetic HTTP only. 200% uses equivalent CSS viewport/DPR, not browser-menu zoom.",cases,keyboard:true,persistence:true,storageDenied:true,crossWindow:true,overlayEscape:true,apiRequests,errors:browser.errors},null,2));
  } finally {await browser.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(temp,{recursive:true,force:true});}
});
