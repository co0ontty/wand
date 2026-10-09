import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";

test("Ant Design foundation preserves popup ownership, focus, keyboard and programmatic feedback", { timeout: 120_000, skip: process.env.WAND_FOUNDATION_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-foundation-"));
  const artifact = join(root, "output/web-ui-library-migration");
  const browserErrors: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { isReactUiEnabled } from "./src/web-ui/react/feature-flags";
    import { WandButton, WandInput, WandSelect, WandDialog, WandDialogSurface, WandPopover,
      WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem,
      WandDropdownMenuSeparator, WandSearchField, WandToastRegion, showWandToast, PortalContainerProvider,
      isWandPopupOwnedBy, WandSwitch, WandTabs, WandStretchTabs, WandSkeleton } from "./src/web-ui/react/ui";
    import { Bubble, Sender } from "./src/web-ui/react/x-library";
    installReactUiStyles();
    const prequeued = showWandToast("queued before mount", { duration: 0 });
    window.foundation = { prequeued, generic: isReactUiEnabled(), selection: "", menu: "", parentCloses: 0, submissions: 0, clear: 0, ref: null };
    function ExtraMenuItems() { return <><WandDropdownMenuItem id="menu-first" onClick={() => { window.foundation.menu = "first"; }}>First</WandDropdownMenuItem>
      <WandDropdownMenuSeparator/><WandDropdownMenuItem id="menu-disabled" disabled>Disabled</WandDropdownMenuItem>
      <WandDropdownMenuItem id="menu-last" onClick={() => { window.foundation.menu = "last"; }}>Last</WandDropdownMenuItem></>; }
    function App() {
      const [parent, setParent] = React.useState(true), [dialog, setDialog] = React.useState(false), [prompt, setPrompt] = React.useState(false);
      const [value, setValue] = React.useState("a"), [search, setSearch] = React.useState("initial"), [checked, setChecked] = React.useState(false), [tab, setTab] = React.useState("a");
      const parentRef = React.useRef(null), selectRef = React.useRef(null), inputRef = React.useRef(null);
      React.useEffect(() => {
        window.foundation.ref = inputRef.current;
        window.foundation.selectRef = selectRef.current;
        const outside = event => {
          if (!parent || parentRef.current?.contains(event.target) || isWandPopupOwnedBy(event.target, "test-parent")) return;
          window.foundation.parentCloses++; setParent(false);
        };
        document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
      }, [parent]);
      return <>
        <div ref={parentRef} id="parent" data-open={parent}>
          <WandSelect triggerRef={selectRef} ariaLabel="Choose model" popupOwner="test-parent" value={value} searchable
            contentClassName="test-owner-menu" options={[{value:"a", label:"Alpha", group:"One"}, {value:"b", label:"Beta", group:"Two"}, {value:"c", label:"Disabled", disabled:true}]}
            onValueChange={next => { window.foundation.selection = next; setValue(next); }}/>
          <WandInput ref={inputRef} aria-label="Plain input" inputSize="sm" value={search} onChange={event => setSearch(event.currentTarget.value)}/>
        </div>
        <div id="outside">Outside</div>
        <WandButton id="show-dialog" onClick={() => setDialog(true)}>Dialog</WandButton>
        <WandButton id="show-prompt" onClick={() => setPrompt(true)}>Prompt</WandButton>
        <WandDropdownMenu><WandDropdownMenuTrigger render={<WandButton id="show-menu">Menu</WandButton>}/>
          <WandDropdownMenuContent id="test-menu" aria-label="Actions"><ExtraMenuItems/>
            <WandDropdownMenuItem id="menu-dialog" onSelect={() => setDialog(true)}>Open dialog</WandDropdownMenuItem>
          </WandDropdownMenuContent></WandDropdownMenu>
        <WandPopover trigger={<WandButton id="show-popover">Popover</WandButton>} contentId="test-popover" contentRole="dialog">
          <WandInput aria-label="Popover input"/></WandPopover>
        <WandSearchField label="Filter" value={search} onValueChange={setSearch} onSearch={next => { window.foundation.search = next; }}/>
        <WandSwitch checked={checked} ariaLabel="Enabled" onCheckedChange={setChecked}/>
        <WandTabs ariaLabel="Tabs" tabs={[{value:"a", label:"A tab", content:"A content"}, {value:"b", label:"B tab", content:"B content"}]}/>
        <WandStretchTabs ariaLabel="Views" value={tab} onValueChange={setTab} tabs={[{value:"a", label:"View A"}, {value:"b", label:"View B"}]}/>
        <WandSkeleton effect="none"/>
        <Bubble content="X display only"/><Sender value="owned draft" readOnly/>
        <WandDialogSurface open={dialog} title="Feature dialog" description={"/project/" + "a-long-unbroken-directory-name".repeat(8) + "/readme.md"}
          testId="feature-dialog" onOpenChange={setDialog}>
          <WandInput aria-label="Dialog input" data-wand-autofocus="true"/>
          <WandSelect ariaLabel="Dialog choice" searchable options={[{value:"x", label:"Nested choice"}]}/>
        </WandDialogSurface>
        <WandDialog open={prompt} title="Prompt dialog" input={{value:"selected value", label:"Prompt input"}}
          actions={[{label:"Accept", value:true, kind:"primary"}]} onAction={() => {window.foundation.submissions++;setPrompt(false);}} onDismiss={() => setPrompt(false)}/>
        <WandToastRegion/>
      </>;
    }
    const portal = document.getElementById("wand-react-ui-portals");
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={portal}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temporary, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    if (request.url === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(readFileSync(join(temporary, "app.js"))); }
    else if (request.url === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (request.url === "/tailwind.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync(join(root, "src/web-ui/content/tailwind.css"))); }
    else { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#root{padding:16px;display:flex;flex-direction:column;gap:12px;max-width:640px}#outside{padding:12px}#parent{display:flex;gap:8px}#parent>*{min-width:0}</style></head><body><div id="root"></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>'); }
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
    const captureCss = cssEvidenceCapture("foundation");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await pause(30); }
      throw new Error(`Timed out: ${expression}; ${await evaluate("JSON.stringify({text:document.body.innerText,visibility:document.visibilityState,popups:Array.from(document.querySelectorAll('.ant-dropdown')).map(n=>({class:n.className,css:getComputedStyle(n).cssText,transform:getComputedStyle(n).transform,animation:getComputedStyle(n).animation,rect:n.getBoundingClientRect().toJSON(),inner:n.querySelector('input')?.getBoundingClientRect().toJSON(),hit:(()=>{let r=n.querySelector('input')?.getBoundingClientRect();return r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,500)})()}))})")}`);
    };
    const click = async (selector: string): Promise<void> => {
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden'})()`);
      await pause(260);
      await wait(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return false;const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(n===hit||n.contains(hit))})()`);
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing target');if(!n.closest('.ant-dropdown,.ant-popover'))n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(n!==hit&&!n.contains(hit))throw Error('Target obstructed: '+${JSON.stringify(selector)}+' hit '+hit?.outerHTML.slice(0,500)+' target '+n.outerHTML+' pointer '+getComputedStyle(n).pointerEvents+' rect '+JSON.stringify(r.toJSON())+' ancestors '+JSON.stringify((()=>{let a=n,result=[];while(a){let s=getComputedStyle(a);result.push({tag:a.tagName,cls:a.className,display:s.display,visibility:s.visibility,transform:s.transform,animation:s.animation,width:s.width,height:s.height,inline:a.getAttribute('style')});a=a.parentElement}return result})()));return{x,y}})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    };
    const key = async (key: string): Promise<void> => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: key === "Escape" ? 27 : key === "Enter" ? 13 : 40 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
    };
    await send("Page.enable"); await send("Runtime.enable");
    for (const mode of process.env.WAND_FOUNDATION_TEST_MODES?.split(",") ?? ["desktop", "mobile", "native", "rollback", "reduced-motion"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: `${origin}/${mode === "rollback" ? "?reactUi=0" : ""}` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
      await send("Page.bringToFront");
      await wait("!!window.foundation?.ref && !!document.querySelector('.ant-notification-notice')");
      if (mode === "native") await evaluate("document.documentElement.classList.add('is-wand-app','is-wand-ios')");
      assert.equal(await evaluate("foundation.ref instanceof HTMLInputElement && foundation.selectRef instanceof HTMLButtonElement"), true, `${mode}: refs`);
      assert.equal(await evaluate("foundation.generic"), mode !== "rollback", `${mode}: generic rollback flag`);
      const scrollbar = await evaluate(`(()=>{const node=document.createElement('div');node.style.cssText='position:fixed;left:-9999px;width:100px;height:40px;overflow:auto';const content=document.createElement('div');content.style.height='200px';node.append(content);document.body.append(node);const styles=getComputedStyle(node),root=getComputedStyle(document.documentElement);window.foundation.scrollProbe=node;return {width:styles.scrollbarWidth,color:styles.scrollbarColor,rootColor:root.scrollbarColor,overflow:node.scrollHeight>node.clientHeight}})()`);
      assert.equal(scrollbar.overflow, true, `${mode}: real overflow surface`);
      assert.equal(scrollbar.width, "thin", `${mode}: scrollbar baseline needs no opt-in class`);
      assert.notEqual(scrollbar.color, "auto", `${mode}: themed scrollbar`);
      assert.equal(scrollbar.color, scrollbar.rootColor, `${mode}: one global scrollbar owner`);
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }, { name: "forced-colors", value: "active" }] });
      const highContrast = await evaluate("({color:getComputedStyle(foundation.scrollProbe).scrollbarColor,width:getComputedStyle(foundation.scrollProbe).scrollbarWidth})");
      assert.deepEqual(highContrast, { color: "auto", width: "auto" }, `${mode}: system-operable high contrast scrollbar`);
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }, { name: "forced-colors", value: "none" }] });
      await evaluate("foundation.scrollProbe.remove();delete foundation.scrollProbe");
      await evaluate("foundation.prequeued.dismiss()");
      await wait("!document.querySelector('.ant-notification-notice')");
      await click('[aria-label="Choose model"]');
      await wait("document.querySelector('.test-owner-menu input') === document.activeElement");
      await click('.test-owner-menu input');
      assert.equal(await evaluate("document.getElementById('parent').dataset.open === 'true' && foundation.parentCloses === 0"), true, `${mode}: search portal ownership`);
      await send("Input.insertText", { text: "Beta" });
      await wait("document.querySelectorAll('.test-owner-menu [role=option]').length === 1");
      await click('.test-owner-menu [role="option"]');
      await wait("foundation.selection === 'b'");
      assert.equal(await evaluate("foundation.parentCloses === 0 && foundation.selectRef === document.activeElement"), true, `${mode}: option ownership and focus`);
      await click('[aria-label="Choose model"]'); await wait("!!document.querySelector('.test-owner-menu input')");
      await key("Escape"); await wait("!document.querySelector('.test-owner-menu input')");
      assert.equal(await evaluate("foundation.selectRef === document.activeElement"), true, `${mode}: escape refocus`);
      await click('#outside'); assert.equal(await evaluate("foundation.parentCloses"), 1, `${mode}: real outside press`);
      await click('#show-menu'); await wait("!!document.getElementById('menu-last')");
      await click('#menu-disabled');
      assert.equal(await evaluate("!foundation.menu && !!document.getElementById('menu-last')"), true, `${mode}: disabled menu action`);
      await click('#menu-last'); await wait("foundation.menu === 'last'");
      await wait("!document.getElementById('test-menu') && document.activeElement.id === 'show-menu'");
      await click('#show-menu'); await click('#menu-dialog');
      await wait("!document.getElementById('test-menu') && document.querySelector('[aria-label=\"Dialog input\"]') === document.activeElement");
      await key("Escape"); await wait("!document.querySelector('[data-testid=feature-dialog]')");
      await click('#show-popover'); await wait("!!document.getElementById('test-popover')");
      await click('[aria-label="Popover input"]'); await key("Escape"); await wait("!document.getElementById('test-popover')");
      await click('#show-dialog'); await wait("document.querySelector('[aria-label=\"Dialog input\"]') === document.activeElement");
      const header = await evaluate(`(()=>{const dialog=document.querySelector('[data-testid=feature-dialog]'),close=dialog.querySelector('button[aria-label=关闭]'),description=dialog.querySelector('.wand-ui-dialog-description');const r=close.getBoundingClientRect(),d=dialog.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {closeInside:r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom,closeReachable:hit===close||close.contains(hit),descriptionContained:description.scrollWidth<=description.clientWidth+1}})()`);
      assert.equal(header.closeInside, true, `${mode}: long path keeps close inside the dialog`);
      assert.equal(header.closeReachable, true, `${mode}: long path keeps close clickable`);
      assert.equal(header.descriptionContained, true, `${mode}: long path wraps within the header`);
      await click('[aria-label="Dialog choice"]'); await wait("!!document.querySelector('.wand-ui-select-content input')");
      if (mode === "desktop" || mode === "mobile") {
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        mkdirSync(artifact, { recursive: true });
        writeFileSync(join(artifact, `foundation-${mode}.png`), Buffer.from(screenshot.data, "base64"));
      }
      await key("Escape"); await wait("!document.querySelector('.wand-ui-select-content input')");
      assert.equal(await evaluate("!!document.querySelector('[data-testid=feature-dialog]')"), true, `${mode}: nested Escape keeps dialog`);
      await key("Escape"); await wait("!document.querySelector('[data-testid=feature-dialog]')");
      await click('#show-prompt'); await wait("document.querySelector('[aria-label=\"Prompt input\"]') === document.activeElement");
      await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
      assert.equal(await evaluate("foundation.submissions"), 0, `${mode}: IME submit boundary`);
      await key("Enter"); await wait("foundation.submissions === 1 && !document.querySelector('[aria-label=\"Prompt input\"]')");
      await click('[aria-label="Enabled"]');
      assert.equal(await evaluate(`document.querySelector('[aria-label="Enabled"]').getAttribute("aria-checked")`), "true", `${mode}: switch`);
      await click('[data-stretch-value="b"]');
      await key("Home");
      assert.equal(await evaluate(`document.querySelector('[data-stretch-value="a"]').closest("label").querySelector("input").checked`), true, `${mode}: Home keyboard contract`);
      await key("End");
      assert.equal(await evaluate(`document.querySelector('[data-stretch-value="b"]').closest("label").querySelector("input").checked`), true, `${mode}: End keyboard contract`);
      const primitives = await evaluate(`({buttons:document.querySelectorAll('.ant-btn').length, appicaSlots:document.querySelectorAll('[data-slot="dialog-content"],[data-slot="dialog-backdrop"],[data-slot="select-trigger"],[data-slot="combobox-trigger"],[data-slot="toast-root"]').length, popupsHidden:!document.querySelector('.wand-ui-select-content input'), x:!!document.querySelector('.ant-bubble')||!!document.querySelector('.antx-bubble'), overflow:document.documentElement.scrollWidth > innerWidth, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches})`);
      assert.equal(primitives.appicaSlots, 0); assert.equal(primitives.overflow, false, `${mode}: no horizontal overflow`);
      console.log(`Foundation browser passed: ${mode}`);
      evidence.push({ mode, ...primitives, scrollbar, highContrast, interactions: ["search and option portal ownership", "outside press", "Escape focus", "composed menu action", "menu selection restores trigger focus", "menu dialog action preserves dialog focus", "popover keyboard close", "dialog autofocus", "nested popup Escape", "IME prompt acceptance", "pre-mount toast queue/dismiss", "disabled menu action", "switch", "Segmented Home/End"] });
    }
    assert.deepEqual(browserErrors, [], "no browser runtime exceptions");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, "foundation-browser.json"), JSON.stringify({ passed: true, evidence, browserErrors, scope: "Foundation fixture in real Chrome; final installed service acceptance remains integration-owned" }, null, 2));
  } catch (error) {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, "foundation-browser.json"), JSON.stringify({ passed: false, evidence, browserErrors, error: String(error) }, null, 2));
    throw error;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) { const stopped = once(chrome, "exit"); chrome.kill(); await stopped; }
    server.close(); rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
