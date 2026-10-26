import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("new task and immediate work share IME-safe submission, editing and Portal Escape", {
  skip: process.env.WAND_NEW_WORK_COMPOSER_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const source = `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {installChatComposerStyles} from "./src/web-ui/react/chat-composer-styles";
    import {installConversationHomeStyles} from "./src/web-ui/react/conversations/home-styles";
    import {installNewWorkStyles} from "./src/web-ui/react/new-session/start-styles";
    import {NewWorkComposer} from "./src/web-ui/react/new-session/composer";
    import {WandButton,WandDialogSurface,WandPopover,WandSearchField,WandSelect} from "./src/web-ui/react/ui";
    installReactUiStyles();installChatComposerStyles();installConversationHomeStyles();installNewWorkStyles();
    window.composerFixture={submits:[],searches:[],selections:[],parentCloses:0,childCloses:0};
    function Fixture(){
      const [text,setText]=React.useState(""),[mode,setMode]=React.useState("work"),[disabled,setDisabled]=React.useState(false);
      const [parent,setParent]=React.useState(false),[child,setChild]=React.useState(false),[search,setSearch]=React.useState("");
      const submit=()=>window.composerFixture.submits.push({mode,text});
      return <section className="new-work-page conversation-root">
        <div className="new-work-heading"><WandButton id="mode" onClick={()=>setMode(mode==="work"?"task":"work")}>切换创建方式</WandButton>
          <WandButton id="disable" onClick={()=>setDisabled(!disabled)}>切换禁用</WandButton>
          <WandButton id="open-parent" onClick={()=>setParent(true)}>任务属性</WandButton></div>
        <div className="new-work-context"><h1>{mode==="work"?"开始工作":"创建任务"}</h1><span id="mode-value">{mode}</span></div>
        <div className="conversation-composer new-work-composer"><NewWorkComposer text={text} onTextChange={setText}
          onSubmit={submit} disabled={disabled} ariaLabel="工作内容" placeholder="描述要完成的事…"
          footer={<WandButton id="submit" disabled={disabled} onClick={submit}>{mode==="work"?"开始工作":"创建任务"}</WandButton>}/></div>
        <WandDialogSurface open={parent} title="任务属性" testId="task-properties" onOpenChange={open=>{setParent(open);if(!open)window.composerFixture.parentCloses++;}}>
          <WandPopover open={child} onOpenChange={open=>{setChild(open);if(!open)window.composerFixture.childCloses++;}}
            contentId="task-search-popup" ariaLabel="选择所属任务" trigger={<WandButton id="open-child">所属任务</WandButton>}>
            <WandSearchField label="搜索任务" value={search} onValueChange={setSearch} onSearch={value=>window.composerFixture.searches.push(value)}/>
          </WandPopover>
          <WandSelect ariaLabel="测试任务选择" searchable searchPlaceholder="搜索测试任务"
            options={[{value:"first",label:"第一个任务"},{value:"second",label:"第二个任务"}]}
            onValueChange={value=>window.composerFixture.selections.push(value)}/>
        </WandDialogSurface>
      </section>;
    }
    createRoot(document.getElementById("root")).render(<WandUiProvider><Fixture/></WandUiProvider>);
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, bundle: true,
    write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/bundle.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text); return; }
    if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(readFileSync("src/web-ui/content/styles.css")); return; }
    if (request.url?.startsWith("/api/")) { requests++; response.statusCode = 500; response.end("No API belongs to this fixture"); return; }
    response.setHeader("content-type", "text/html;charset=utf-8");
    response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:100%;margin:0;position:relative}</style><div id="root"></div><script src="/bundle.js"></script></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await openBrowser(`http://127.0.0.1:${(server.address() as any).port}`, 1280, 900);
  t.after(() => browser.close());
  const output = "output/new-work-composer-browser"; mkdirSync(output, { recursive: true });
  await browser.wait("!!document.querySelector('textarea')");
  await browser.click("textarea");
  await browser.send("Input.insertText", { text: "输入法确认候选后再开始" });
  const count = () => browser.evaluate("composerFixture.submits.length");
  await browser.evaluate("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'zhong'}));true");
  await browser.key("Enter");
  assert.equal(await count(), 0, "a native Enter while composing cannot start work");
  await browser.evaluate(`(()=>{const input=document.querySelector('textarea');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',keyCode:13,isComposing:false}));return true})()`);
  assert.equal(await count(), 0, "Safari's same-turn trailing Enter cannot start work");
  await browser.evaluate("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',keyCode:229,isComposing:false}));true");
  assert.equal(await count(), 0, "keyCode 229 is a candidate confirmation even without isComposing");
  await browser.key("Enter");
  assert.equal(await count(), 1, "deliberate Enter invokes exactly one submission");
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8, text: "\r", unmodifiedText: "\r" });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await browser.settle();
  assert.equal(await count(), 1, "Shift+Enter only edits");
  assert.match(await browser.evaluate("document.querySelector('textarea').value"), /\n$/, "Shift+Enter inserts a real newline");
  const geometry = () => browser.evaluate(`(()=>{const input=document.querySelector('textarea'),sender=document.querySelector('.conversation-sender');const a=getComputedStyle(input),b=getComputedStyle(sender);
    return {font:a.font,border:b.border,borderRadius:b.borderRadius,padding:b.padding,width:sender.getBoundingClientRect().width}})()`);
  const workStyle = await geometry();
  const text = await browser.evaluate("document.querySelector('textarea').value");
  await browser.click("#mode");
  assert.equal(await browser.evaluate("document.querySelector('#mode-value').textContent"), "task");
  assert.equal(await browser.evaluate("document.querySelector('textarea').value"), text, "changing task mode preserves the input");
  await browser.click("textarea");
  assert.deepEqual(await geometry(), workStyle, "both task modes use identical input styling");
  await browser.key("Enter");
  assert.equal(await count(), 2);
  assert.equal(await browser.evaluate("composerFixture.submits.at(-1).mode"), "task");
  await browser.click("#disable"); await browser.click("textarea"); await browser.key("Enter");
  assert.equal(await count(), 2, "pending/disabled creation cannot submit again");
  await browser.click("#disable");
  await browser.screenshot(output + "/composer-desktop.png");

  await browser.click("#open-parent"); await browser.wait("!!document.querySelector('[data-testid=task-properties]')");
  await browser.click("#open-child"); await browser.wait("!!document.querySelector('[aria-label=搜索任务]')");
  await browser.click("[aria-label=搜索任务]"); await browser.send("Input.insertText", { text: "任务" });
  assert.equal(await browser.evaluate("composerFixture.parentCloses"), 0, "clicking the portalled search keeps the parent open");
  await browser.evaluate("document.querySelector('[aria-label=搜索任务]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true");
  await browser.key("Escape");
  assert.equal(await browser.evaluate("composerFixture.childCloses"), 0);
  await browser.evaluate(`(()=>{const input=document.querySelector('[aria-label=搜索任务]');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'任务'}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',keyCode:27,isComposing:false}));return true})()`);
  assert.equal(await browser.evaluate("composerFixture.childCloses"), 0, "candidate Escape keeps the child open");
  await browser.key("Escape");
  assert.equal(await browser.evaluate("composerFixture.childCloses"), 1);
  assert.equal(await browser.evaluate("composerFixture.parentCloses"), 0, "first deliberate Escape only closes the top Portal");
  await browser.click('[aria-label="测试任务选择"]'); await browser.wait("!!document.querySelector('[aria-label=搜索测试任务]')");
  await browser.click('[aria-label="搜索测试任务"]');
  await browser.evaluate("document.querySelector('[aria-label=搜索测试任务]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true");
  await browser.key("ArrowDown");
  assert.equal(await browser.evaluate("document.activeElement===document.querySelector('[aria-label=搜索测试任务]')"), true, "active candidate navigation keeps focus in the actual WandSelect search");
  await browser.evaluate(`(()=>{const input=document.querySelector('[aria-label=搜索测试任务]');input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'ArrowDown',keyCode:40,isComposing:false}));return true})()`);
  assert.equal(await browser.evaluate("document.activeElement===document.querySelector('[aria-label=搜索测试任务]')"), true, "trailing WebKit candidate key cannot focus a task option");
  await browser.evaluate("document.querySelector('[aria-label=搜索测试任务]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'ArrowUp',keyCode:229,isComposing:false}));true");
  assert.equal(await browser.evaluate("document.activeElement===document.querySelector('[aria-label=搜索测试任务]')"), true, "229 candidate key cannot focus an option");
  await browser.key("ArrowDown");
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('role')"), "option", "deliberate navigation remains available after composition");
  await browser.key("Enter");
  assert.deepEqual(await browser.evaluate("composerFixture.selections"), ["first"]);
  assert.equal(await browser.evaluate("composerFixture.parentCloses"), 0, "selecting an actual task option keeps the parent open");
  await browser.click('[aria-label="测试任务选择"]'); await browser.wait("!!document.querySelector('[aria-label=搜索测试任务]')");
  assert.equal(await browser.evaluate("document.activeElement===document.querySelector('[aria-label=搜索测试任务]')"), true, "reopening focuses the fresh search input");
  await browser.click('[role="option"][title="第二个任务"]');
  assert.deepEqual(await browser.evaluate("composerFixture.selections"), ["first", "second"]);
  assert.equal(await browser.evaluate("composerFixture.parentCloses"), 0, "clicking a Portal task option also preserves the parent");
  await browser.key("Escape");
  assert.equal(await browser.evaluate("composerFixture.parentCloses"), 1);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await browser.settle();
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await browser.screenshot(output + "/composer-390.png");
  assert.equal(requests, 0, "the fixture never calls API or paid models");
  assert.deepEqual(browser.errors, []);
  writeFileSync(output + "/result.json", JSON.stringify({ ok: true, assertions: ["composition Enter", "Safari trailing Enter", "keyCode229", "single Enter submit", "Shift+Enter newline", "shared task styles", "disabled repeat", "Portal candidate Escape", "topmost Escape", "select candidate arrows", "select committed arrows", "select option preserves parent", "390px"], requests, browserErrors: browser.errors }, null, 2));
});
