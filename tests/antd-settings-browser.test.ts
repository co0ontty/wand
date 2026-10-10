import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import { installLayoutShiftObserver, runPageLayoutQa } from "./helpers/page-layout-qa.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";

test("settings tabs use Ant controls and preserve draft, ordering, permission and popup contracts", { timeout: 180_000, skip: process.env.WAND_SETTINGS_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-settings-"));
  const artifact = join(root, "output/settings-page-20261009/browser");
  const browserErrors: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  let access = "admin", failSave = false, holdSave = false;
  let qrFail = true, qrRequests = 0;
  let releaseSave: (() => void) | undefined;
  let qaLoadMode = "normal";
  const commands: Array<{path: string; value: any}> = [];
  let config: Record<string, any> = {
    host: "127.0.0.1", port: 3000, https: false, defaultMode: "default", defaultCwd: "/tmp",
    shell: "/bin/zsh", language: "", inheritEnv: true, defaultProvider: "claude", defaultThinkingEffort: "off",
    defaultModel: "first", defaultCodexModel: "codex-first", defaultPiModel: "",
    modelGroups: [{ id: "coding", provider: "claude", name: "编程分组", models: ["first", "second"] }],
    commandPresets: [{label: "示例预设", command: "echo example", mode: "default"}],
    cardDefaults: { editCards: false, inlineTools: false, terminal: false, thinking: false },
    taskRetention: { autoArchiveEnabled: false, autoArchiveDays: 7, autoDeleteEnabled: false, autoDeleteDays: 30 },
    userProfile: { name: "", avatar: "" },
  };
  const models = { models: [{id:"default",label:"默认"},{id:"first",label:"首选模型"},{id:"second",label:"备用模型"}],
    codexModels:[{id:"codex-first",label:"Codex First"}], freeModels:[], piModels:[] };
  const about = () => ({packageName:qaLoadMode === "long" ? "超长软件包名称 LongPackageIdentifier".repeat(20) : "wand-local", version:"4.83.1", nodeVersion:">=26", updateChannel:"stable",
    build:{}, androidApk:{enabled:true},macosDmg:{enabled:true},iosIpa:{enabled:true},
    config, desiredConfig:config, activeConfig:config, githubConnector:{connected:false},
    autoUpdate:{}, openRouter:{configured:false,modelCount:0,lastError:null}});
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { SettingsHost } from "./src/web-ui/react/settings/host";
    import { settingsController } from "./src/web-ui/react/settings/controller";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    installReactUiStyles();
    Object.defineProperty(navigator, "clipboard", {value:{writeText:async()=>{window.fixtureCopies=(window.fixtureCopies||0)+1;}}});
    if (location.search.includes("native")) { document.documentElement.classList.add("is-wand-app","is-wand-ios");
      window.WandNative = {getAvailableSounds:()=>JSON.stringify([{id:"native-one",name:"原生铃声"}]),
        getNotificationSound:()=>"native-one", isHapticEnabled:()=>true, getPermission:()=>"denied",
        sendNotification:()=>{}}; }
    window.settingsHarness = {open: settingsController.open, close: settingsController.close};
    createRoot(document.getElementById("root")).render(<SettingsHost/>);
    settingsController.open("general");
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      response.setHeader("content-type", "application/json");
      if (path === "/api/settings" && qaLoadMode === "loading") { await new Promise<void>(resolve=>setTimeout(resolve,10_000)); }
      if (path === "/api/settings" && qaLoadMode === "error") { response.statusCode=500;response.end(JSON.stringify({error:"Fixture settings load failed — 设置未修改"}));return; }
      if (path === "/api/settings" && access !== "admin") { response.statusCode=403; response.end(JSON.stringify({error:"管理权限不足"})); return; }
      let value: any = {};
      if (request.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        // Only nonsecret settings payloads are collected; credential commands never enter outputs.
        if (path === "/api/settings/config") {
          commands.push({path,value});
          if (failSave) { response.statusCode=500; response.end(JSON.stringify({error:"保存失败，草稿已保留"})); return; }
          if (holdSave) await new Promise<void>((resolve) => { releaseSave = resolve; });
          config = {...config,...value};
          response.end(JSON.stringify({ok:true,config,desiredConfig:config,activeConfig:config,restartRequired:false})); return;
        }
        if (path === "/api/settings/openrouter") { response.statusCode=500; response.end(JSON.stringify({error:"本地验证失败"})); return; }
      }
      const payload = path === "/api/settings" || path === "/api/settings/about" ? about()
        : path === "/api/models" ? models
        : path === "/api/provider-cli-updates" ? {items:[],autoUpdate:false}
        : path === "/api/app-connect-code" ? {code:"local-browser-fixture",url:""}
        : path === "/api/silicon-employees" ? {employees:[]}
        : path === "/api/sessions/provider-usage" ? {claude:5,codex:2}
        : path === "/api/settings/env-preview" ? {inheritEnv:true,total:1,reveal:false,entries:[{name:"EXAMPLE",value:"masked",length:6,sensitive:false}]}
        : path === "/api/check-update" ? {channel:"stable",current:"4.83.1",latest:"4.83.1",updateAvailable:false}
        : value;
      response.end(JSON.stringify(payload)); return;
    }
    if (path === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(readFileSync(join(temporary, "app.js"))); }
    else if (path === "/fixture-qrcode.js") {
      qrRequests += 1;
      response.setHeader("content-type", "application/javascript");
      if (qrFail) { response.statusCode=503; response.end(""); }
      else response.end('window.QRCodeLib={toCanvas:(canvas,code,options,done)=>{window.fixtureQrDraws=(window.fixtureQrDraws||0)+1;done(null);}};');
    }
    else if (path === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (path === "/tailwind.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/tailwind.css"))); }
    else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(themeFixtureHtml('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wand-qrcode-script" content="/fixture-qrcode.js"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>')); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const portFile = join(temporary, "profile/DevToolsActivePort");
    for (let attempt = 0; attempt < 120 && !existsSync(portFile); attempt++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome debugging endpoint available");
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(targets.find(target => target.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params.exceptionDetails));
      const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
      message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const captureCss = cssEvidenceCapture("settings");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await pause(30); }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async (selector: string): Promise<void> => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n.closest('.ant-dropdown,.ant-popover'))n.scrollIntoView({block:"nearest",behavior:"instant"})})()`);
      await pause(280);
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;if(!n.closest('.ant-dropdown,.ant-popover'))n.scrollIntoView({block:"nearest",behavior:"instant"});const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(n===hit||n.contains(hit))})()`);
      const locate = () => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!(n===hit||n.contains(hit)))throw Error("Target obstructed: "+${JSON.stringify(selector)});return{x,y}})()`);
      await send("Page.bringToFront");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...await locate() });
      await pause(80);
      const point = await locate();
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    };
    const clickText = async (text: string, role = "button"): Promise<void> => {
      if (role === "tab" && await evaluate('!!document.querySelector("[aria-label=返回设置目录]")?.getClientRects().length')) await click('[aria-label="返回设置目录"]');
      await evaluate(`(()=>{const n=Array.from(document.querySelectorAll(${JSON.stringify(role === "tab" ? '[role="menuitem"]' : 'button')})).find(n=>n.getClientRects().length&&(n.querySelector('.wand-settings-library-nav-copy>span')?.innerText||n.innerText).trim()===${JSON.stringify(text)});if(!n)throw Error("Missing action: "+${JSON.stringify(text)});n.setAttribute("data-settings-test-target","true")})()`);
      if (role === "tab") await evaluate('document.querySelector("[data-settings-test-target]").focus({preventScroll:true})');
      try { await click('[data-settings-test-target="true"]'); }
      catch (error) { throw new Error(`Cannot click ${role}: ${text}: ${String(error)}; layout=${await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.ant-modal-body,.wand-settings-library-tabs,.ant-tabs-body-holder,[data-settings-test-target]')).map(n=>({tag:n.tagName,cls:n.className,rect:n.getBoundingClientRect().toJSON(),scroll:n.scrollTop,scrollHeight:n.scrollHeight,overflow:getComputedStyle(n).overflow,display:getComputedStyle(n).display,height:getComputedStyle(n).height})))`)} `); }
      await evaluate('document.querySelector("[data-settings-test-target]")?.removeAttribute("data-settings-test-target")');
    };
    const enter = async (selector: string, text: string): Promise<void> => {
      await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
      await send("Input.insertText", {text});
    };
    const key = async (key: string): Promise<void> => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: ({ Escape:27, Enter:13, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Home:36, End:35 } as Record<string,number>)[key] ?? 0 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
    };
    await send("Page.enable"); await send("Runtime.enable");
    if (process.env.WAND_PAGE_LAYOUT_QA === "1") {
      await installLayoutShiftObserver(send);
      const prepare=async(condition:string)=>{
        qaLoadMode=condition;holdSave=false;
        await evaluate("window.__wandFixtureBeforeNavigation=true");
        await send("Page.navigate",{url:origin});
        await wait("!window.__wandFixtureBeforeNavigation && !!document.querySelector('[data-testid=settings-page]')");
        if(condition === "loading") {await wait("!!document.querySelector('[aria-label=正在加载设置]')");return;}
        if(condition === "error") {await wait("document.body.innerText.includes('Fixture settings load failed')");return;}
        await wait("!!document.querySelector('#settings-host')");
        if(condition === "long") {await evaluate("settingsHarness.open('about')");await wait("document.body.innerText.includes('LongPackageIdentifier')");}
        if(condition === "empty") {
          if(await evaluate("!!document.querySelector('[aria-label=返回设置目录]')"))await click('[aria-label="返回设置目录"]');
          await click('[aria-label="查找设置分组"]');await send("Input.insertText",{text:"不存在的设置 unmatched-no-result"});await wait("document.body.innerText.includes('没有匹配的设置分组')");
        }
        if(condition === "disabled") {holdSave=true;await clickText("保存基本配置");await wait("!!document.querySelector('.wand-settings-library-save-bar button:disabled')");}
      };
      const widths=[320,390,639,640,768,1024,1440,1920];
      const cases=widths.flatMap(width=>["normal","long"].map(condition=>({width,condition,reducedMotion:false,prepare:()=>prepare(condition)})));
      const extra=[320,1024].flatMap(width=>["loading","empty","error","disabled"].map(condition=>({width,condition,prepare:()=>prepare(condition)})));
      const records=await runPageLayoutQa({page:"settings",artifact:join(root,"output/sidebar-refinement/order-pages-qa"),driver:{send,evaluate,wait},cases:[...cases,...extra,{width:390,condition:"safe-area",safeArea:true,prepare:()=>prepare("long")},{width:1280,condition:"zoom-200-equivalent",zoomEquivalent:true,prepare:()=>prepare("normal")}],rootSelector:".wand-settings-library-page",titleSelector:".wand-settings-library-page-heading h1",secondarySelector:".wand-settings-library-overview,.wand-settings-library-panel-heading p,.wand-settings-library-nav-description",buttonSelector:".wand-settings-library-save-bar button:not(:disabled) span,.wand-settings-library-access-page button span",disabledSelector:".wand-settings-library-save-bar button:disabled",limitations:["Safe-area tokens are emulated; the outer workspace shell is not mounted","API loading is intentionally delayed; no actual service configuration is written"]});
      releaseSave?.();holdSave=false;
      assert.deepEqual(browserErrors,[],"layout QA has no browser runtime exceptions");
      assert.deepEqual(records.flatMap(r=>r.issues.map((issue:string)=>`${r.width}/${r.condition}: ${issue}`)),[],"checked geometry, contrast and accessible names");
      assert.ok(records.every(r=>r.evidence.performance.maxSessionWindowCls<=0.1),"isolated settings initial-load CLS stays below 0.1");
      console.log(`Settings layout QA: ${records.length} cases; ${records.filter(r=>r.issues.length).length} with findings`);
      return;
    }
    const tabs = ["我的资料","连接器","基本配置","AI 与模型","通知","显示","安全","命令预设","关于"];
    for (const mode of process.env.WAND_SETTINGS_TEST_MODES?.split(",") ?? ["desktop","mobile","native","rollback","reduced-motion"]) {
      access="admin"; failSave=false;
      qrFail=true; const qrRequestBaseline=qrRequests;
      await send("Emulation.setDeviceMetricsOverride", {width:mode === "mobile" ? 390 : 1280,height:1000,deviceScaleFactor:1,mobile:false});
      await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:mode === "reduced-motion" ? "reduce" : "no-preference"}]});
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", {url:origin+(mode === "rollback" ? "/?reactUi=0" : mode === "native" ? "/?native" : "/")});
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
      await send("Page.bringToFront"); await wait('!!document.querySelector("#settings-host")');
      assert.equal(await evaluate('document.querySelectorAll(".ant-modal-wrap").length'),0,`${mode}: settings open as a page`);
      assert.equal(await evaluate('document.querySelector("[data-testid=settings-page]").getBoundingClientRect().height'),1000,`${mode}: settings fill the content height`);
      assert.equal(await evaluate('document.querySelector("#settings-host").classList.contains("ant-input")'),true);
      assert.equal(qrRequests,qrRequestBaseline,`${mode}: ordinary settings do not load the optional QR library`);
      assert.equal(await evaluate('document.body.innerText.includes("保存本页后立即扫描") && document.body.innerText.includes("自动删除已关闭")'),true,`${mode}: retention consequences are visible before saving`);
      await click('[role="switch"][aria-label="自动删除到期内容"]');
      await wait('document.body.innerText.includes("自动删除已开启")');
      assert.equal(await evaluate('document.body.innerText.includes("满 30 天") && document.body.innerText.includes("删除后的内容无法恢复")'),true,`${mode}: enabled deletion has a prospective warning`);
      await click('[role="switch"][aria-label="自动删除到期内容"]');
      await wait('document.body.innerText.includes("自动删除已关闭")');
      await click('[aria-label="AI 回复语言"]');
      await wait('!!document.querySelector(".wand-ui-select-content [role=option][title=简体中文]")');
      await click('.wand-ui-select-content [role=option][title=简体中文]');
      assert.equal(await evaluate('!!document.querySelector("[data-testid=settings-page]").getClientRects().length && document.body.innerText.includes("网页尚未完整支持语言切换")'),true,`${mode}: reply language uses the owned selector and names its scope`);
      await enter("#settings-host","draft.example"); failSave=true;
      await clickText("保存基本配置"); await wait('document.body.innerText.includes("保存失败，草稿已保留")');
      assert.equal(await evaluate('document.querySelector("#settings-host").value'),"draft.example",`${mode}: rejected save retains input`);
      failSave=false; holdSave=true;
      const saveCount=commands.length;
      const saveRect=await evaluate("(()=>{let r=document.querySelector('.wand-settings-library-save-bar button').getBoundingClientRect();return {width:r.width,height:r.height}})()");
      await click('.wand-settings-library-save-bar button');
      for(let i=0;i<100&&commands.length===saveCount;i++) await pause(20);
      assert.ok(releaseSave,"save is in flight");
      const pendingRect=await evaluate("(()=>{let r=document.querySelector('.wand-settings-library-save-bar button').getBoundingClientRect();return {width:r.width,height:r.height}})()");
      assert.ok(Math.abs(pendingRect.width-saveRect.width)<0.5 && Math.abs(pendingRect.height-saveRect.height)<0.5,`${mode}: save button keeps size while pending (within modal animation subpixels)`);
      await enter("#settings-host","newer.example");
      holdSave=false; releaseSave(); releaseSave=undefined;
      await wait('document.body.innerText.includes("基本配置已保存")');
      assert.equal(commands.at(-1)!.value.language,"中文",`${mode}: Chinese choice sends the language directive's canonical value`);
      assert.equal(await evaluate('document.querySelector("#settings-host").value'),"newer.example",`${mode}: late receipt retains newer draft`);
      const generalScroll = await evaluate('document.querySelector("[data-settings-panel=general]").scrollTop');
      await clickText("显示", "tab");
      await clickText("基本配置", "tab");
      assert.equal(await evaluate('document.querySelector("#settings-host").value'), "newer.example", `${mode}: switching sections preserves the unsaved input`);
      assert.equal(await evaluate('document.querySelector("[data-settings-panel=general]").scrollTop'), generalScroll, `${mode}: switching sections restores their scroll position`);
      if (mode === "mobile") await click('[aria-label="返回设置目录"]');
      await enter('[aria-label="查找设置分组"]', "SSL");
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[role=menuitem] .wand-settings-library-nav-copy>span:first-child")).map(n=>n.innerText.trim())'), ["安全"], `${mode}: search includes each section's purpose`);
      await enter('[aria-label="查找设置分组"]', "没有这个设置");
      assert.equal(await evaluate('document.body.innerText.includes("没有匹配的设置分组")'), true, `${mode}: search has an honest no-match state`);
      await click('[aria-label="清空搜索"]');
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), "查找设置分组", `${mode}: clearing search retains focus`);
      if (mode === "desktop" || mode === "mobile") {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, `settings-${mode}-directory.png`), Buffer.from(shot.data, "base64"));
      }
      const coverage: Array<Record<string,unknown>>=[];
      for (const tab of tabs) {
        await clickText(tab,"tab"); await pause(140);
        assert.equal(await evaluate(`!!document.querySelector('[data-settings-panel]:not([hidden]) .wand-settings-library-panel')`),true,`${mode}: ${tab}`);
        if (tab === "连接器") {
          assert.equal(await evaluate('document.body.innerText.includes("当前支持 GitHub")'),true,`${mode}: connector purpose is explicit`);
          assert.equal(await evaluate('(()=>{const n=document.getElementById("settings-github-api-url");return !n||n.getBoundingClientRect().height===0})()'),true,`${mode}: Enterprise address stays out of the ordinary connection form`);
          await click('[data-settings-panel]:not([hidden]) .ant-collapse-header');
          await wait('!!document.getElementById("settings-github-api-url") && document.getElementById("settings-github-api-url").getBoundingClientRect().height>0');
          assert.equal(await evaluate('document.getElementById("settings-github-api-url").value'),"https://api.github.com",`${mode}: expanding advanced settings preserves the default address`);
          await click('[data-settings-panel]:not([hidden]) .ant-collapse-header');
          await wait('document.getElementById("settings-github-api-url").getBoundingClientRect().height===0');
        }
        if (tab === "关于") {
          await wait('document.body.innerText.includes("二维码加载或生成失败")');
          assert.equal(qrRequests,qrRequestBaseline+1,`${mode}: first QR use requests the library lazily`);
          const copies=await evaluate('window.fixtureCopies||0');
          await clickText("复制连接码"); await wait(`window.fixtureCopies===${copies+1}`);
          qrFail=false;
          await clickText("重试二维码"); await wait('(window.fixtureQrDraws||0)>0');
          assert.equal(qrRequests,qrRequestBaseline+2,`${mode}: failed QR load can retry without blocking copy`);
        }
        coverage.push({tab,...await evaluate(`({legacyControls:document.querySelectorAll('.wand-settings-input,.wand-settings-field,.wand-settings-section,.wand-model-group-disclosure,.wand-settings-range').length,antCards:document.querySelectorAll('.ant-card').length})`)});
        if (mode === "desktop" || mode === "mobile") {
          await evaluate("document.querySelector('[data-settings-panel]:not([hidden])').scrollTop=0");
          // Mask credentials and connection artifacts even when this fixture contains no real ones.
          await evaluate(`(()=>{const s=document.createElement('style');s.id='settings-redact';s.textContent='input[type=password],.wand-settings-library-connect-code,[data-testid=settings-connect-qr]{visibility:hidden!important}';document.head.append(s)})()`);
          const shot=await send("Page.captureScreenshot",{format:"png"});mkdirSync(artifact,{recursive:true});
          writeFileSync(join(artifact,`settings-${mode}-${tabs.indexOf(tab)}.png`),Buffer.from(shot.data,"base64"));
          await evaluate('document.getElementById("settings-redact").remove()');
        }
      }
      await clickText("基本配置","tab");
      await clickText("查看将注入的环境变量"); await wait('!!document.querySelector("[data-testid=settings-environment-dialog] .ant-table")');
      await click('[data-testid=settings-environment-dialog] [aria-label="搜索变量名"]');
      await key("Escape"); await wait('!document.querySelector("[data-testid=settings-environment-dialog]")');
      assert.equal(await evaluate('!!document.querySelector("[data-testid=settings-page]").getClientRects().length'),true,`${mode}: nested Escape`);
      await clickText("AI 与模型","tab");
      await click('[aria-label="Claude 默认模型"]'); await wait('!!document.querySelector(".wand-ui-select-content input")');
      await click('.wand-ui-select-content input'); await send("Input.insertText",{text:"备用"});
      await wait('document.querySelectorAll(".wand-ui-select-content [role=option]").length===1');
      await click('.wand-ui-select-content [role=option]');
      assert.equal(await evaluate('!!document.querySelector("[data-testid=settings-page]").getClientRects().length'),true,`${mode}: option portal stays owned`);
      await clickText("保存 AI 与模型配置"); await wait('document.body.innerText.includes("AI 与模型配置已保存")');
      assert.equal(commands.at(-1)!.value.defaultModel,"second");
      assert.equal(commands.at(-1)!.value.defaultCodexModel,"codex-first",`${mode}: other provider choice retained`);
      await click('[data-settings-panel]:not([hidden]) .ant-collapse-header'); await wait(`!!document.querySelector('[aria-label="下移模型 1"]')`);
      await click('[aria-label="下移模型 1"]');
      await wait("document.querySelector('.wand-settings-library-group-members[aria-label=\"编程分组 的模型顺序\"] li')?.textContent.includes('备用模型')");
      await wait("Array.from(document.querySelectorAll('button')).find(n=>n.innerText.trim()==='保存模型分组')?.disabled === false");
      await clickText("保存模型分组");
      try { await wait('document.body.innerText.includes("模型分组与顺序已保存")'); }
      catch { throw new Error(`${mode}: group save did not settle; commands=${commands.length}; last=${commands.at(-1)?.value.modelGroups ? "modelGroups.save" : "other"}; alerts=${await evaluate("Array.from(document.querySelectorAll('.ant-alert')).map(n=>n.innerText).join('|')")}`); }
      assert.equal(commands.at(-1)!.value.modelGroups[0].models[0],"second");
      await click('[data-settings-panel]:not([hidden]) .ant-collapse-header');
      await wait(`(()=>{const n=document.querySelector('[aria-label="下移模型 1"]');return !n||n.getBoundingClientRect().height===0})()`);
      // Restore the fixture order for the next mode, without invoking any real service.
      config.modelGroups[0].models=["first","second"];
      await clickText("基本配置","tab");
      assert.equal(await evaluate('document.querySelector("#settings-host").value'),"newer.example",`${mode}: unrelated model save retains draft`);
      await clickText("AI 与模型","tab");
      await wait('document.body.innerText.includes("全局默认用于之后新建的会话")');
      assert.equal(await evaluate('document.querySelector("#settings-openrouter-key").type'), "password", `${mode}: secret starts masked`);
      await click('[aria-controls="settings-openrouter-key"][aria-label="显示敏感内容"]');
      assert.equal(await evaluate('document.querySelector("#settings-openrouter-key").type'), "text", `${mode}: explicit reveal`);
      await key("Tab");
      await click('[aria-controls="settings-openrouter-key"][aria-label="隐藏敏感内容"]');
      assert.equal(await evaluate('document.querySelector("#settings-openrouter-key").type'), "password", `${mode}: re-mask`);
      await enter("#settings-openrouter-key","local-fixture-input"); await clickText("保存并同步");
      await wait('document.body.innerText.includes("本地验证失败")');
      assert.equal(await evaluate('document.querySelector("#settings-openrouter-key").value.length>0'),true,`${mode}: credential draft retained on failure`);
      await clickText("通知","tab"); await wait('!!document.querySelector(".ant-slider")');
      await click('.ant-slider-handle');
      await wait(`document.querySelector('.ant-slider-handle').getAttribute('aria-disabled')!=='true'`);
      const volumeBefore=Number(await evaluate(`document.querySelector('.ant-slider-handle').getAttribute('aria-valuenow')`));
      await key("ArrowRight");
      await wait(`document.querySelector('.ant-slider-handle').getAttribute('aria-valuenow')==='${Math.min(100,volumeBefore+5)}'`);
      await clickText("我的资料","tab");
      await enter("#settings-profile-name","赛博虎妞");
      await click('[aria-label="上传头像图片"]').catch(() => {});
      await click('.wand-team-coat[aria-pressed]');
      await clickText("保存资料");
      try { await wait('document.body.innerText.includes("资料已保存")'); }
      catch { throw new Error(`${mode}: profile save did not settle; last=${JSON.stringify(commands.at(-1)?.value.userProfile)}; alerts=${await evaluate("Array.from(document.querySelectorAll('.ant-alert')).map(n=>n.innerText).join('|')")}`); }
      assert.equal(commands.at(-1)!.value.userProfile.name,"赛博虎妞",`${mode}: profile name submitted trimmed`);
      assert.match(String(commands.at(-1)!.value.userProfile.avatar),/^(cat:\d+|data:image\/)/,`${mode}: profile avatar submitted as picked`);
      await clickText("安全","tab");
      assert.equal(await evaluate('document.querySelectorAll(".ant-upload input[type=file]").length'),2,`${mode}: local controlled Upload`);
      await clickText("关于","tab"); await clickText("检查更新"); await wait('document.body.innerText.includes("版本检查完成")');
      const result = await evaluate(`({antInputs:document.querySelectorAll('.ant-input,.ant-input-number').length,antCards:document.querySelectorAll('.ant-card').length,overflow:document.documentElement.scrollWidth>innerWidth,legacy:document.querySelectorAll('.wand-settings-input,.wand-settings-field,.wand-settings-section,.wand-settings-dialog,.wand-model-group-disclosure,.wand-settings-range').length})`);
      assert.equal(result.legacy,0); assert.equal(result.overflow,false,`${mode}: no horizontal overflow`);
      evidence.push({mode,tabs,coverage,...result,interactions:["failed general save retains draft","late save receipt retains newer draft","unrelated model save retains general draft","search and option Portal","nested Escape","all provider choices retained","model group order save","OpenRouter failure retains draft","keyboard Slider","controlled Upload","update check"]});
      if (mode === "desktop" || mode === "mobile") {
        await evaluate(`(()=>{const s=document.createElement('style');s.id='settings-redact';s.textContent='input[type=password],.wand-settings-library-connect-code,[data-testid=settings-connect-qr]{visibility:hidden!important}';document.head.append(s)})()`);
        const shot=await send("Page.captureScreenshot",{format:"png"});mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,`settings-${mode}.png`),Buffer.from(shot.data,"base64"));
        await evaluate('document.getElementById("settings-redact").remove()');
      }
      if (mode === "mobile") { await key("Escape"); await wait('!!document.querySelector("[aria-label=设置目录]").getClientRects().length'); }
      await key("Escape"); await wait('!document.querySelector("[data-testid=settings-page]").getClientRects().length');
      access="read-only";
      await evaluate('settingsHarness.open("general")');
      await wait('!document.querySelector("#settings-host")');
      if (mode === "mobile") await click('[aria-label="返回设置目录"]');
      await click('.wand-settings-library-access .ant-collapse-header');
      await wait('!!document.querySelector("#settings-admin-password")');
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[role=menuitem] .wand-settings-library-nav-copy>span:first-child")).map(n=>n.innerText.trim())'),["通知","本地模型","语音输入","关于"],`${mode}: connected App cannot reach administrator settings`);
      assert.equal(await evaluate('!!document.querySelector("#settings-host")'),false);
      for(const type of ["mousePressed","mouseReleased"]) await send("Input.dispatchMouseEvent",{type,x:5,y:5,button:"left",clickCount:1});
      assert.equal(await evaluate('!!document.querySelector("[data-testid=settings-page]").getClientRects().length'),true,`${mode}: clicking page space does not dismiss settings`);
      await click('[aria-label="返回工作台"]');
      await wait('!document.querySelector("[data-testid=settings-page]").getClientRects().length');
    }
    assert.deepEqual(browserErrors,[],"no browser runtime exceptions");
    mkdirSync(artifact,{recursive:true});
    writeFileSync(join(artifact,"settings-browser.json"),JSON.stringify({passed:true,evidence,scope:"Current production SettingsHost and HTTP repository in real Chrome with local API fixtures. Installed service/native host acceptance remains integration-owned."},null,2));
  } catch(error) {
    mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,"settings-browser.json"),JSON.stringify({passed:false,evidence,error:String(error),browserErrors},null,2));throw error;
  } finally {
    socket?.close(); if(chrome.exitCode===null){const stopped=once(chrome,"exit");chrome.kill();await stopped;}
    server.close();rmSync(temporary,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
