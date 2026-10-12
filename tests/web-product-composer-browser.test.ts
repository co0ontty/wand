import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

// Production owners, actual pointer/keyboard input. API data is explicit read-only
// fixture data; any model execution or configuration mutation fails the test.
test("product composer retains long drafts, readable bubbles and accessible attachment previews", {
  skip: process.env.WAND_PRODUCT_COMPOSER_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const root = resolve(import.meta.dirname, ".."), output = join(root, "output/product-completion-20261011/browser");
  mkdirSync(output, { recursive: true });
  const source = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';
    import {PortalContainerProvider} from './src/web-ui/react/ui';
    import {installReactUiStyles} from './src/web-ui/react/styles';
    import {ConversationHome} from './src/web-ui/react/conversations/home';
    import {conversationUi,conversationDraftKey} from './src/web-ui/react/conversations/state';
    import {notifyConversationChanges} from './src/web-ui/react/conversations/repository';
    import {ComposerStore} from './src/web-ui/browser/composer';
    import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    import {ImageViewerHost} from './src/web-ui/react/deferred-hosts'; import {imageViewerController} from './src/web-ui/react/image-viewer/controller';
    import {AgentFields} from './src/web-ui/react/issues/agent-fields';
    import {DisplaySettingsTab} from './src/web-ui/react/settings/tabs';
    import {setWandTheme} from './src/web-ui/react/theme-preference';
    import './src/web-ui/react/ai-teams/chunk-entry';
    installReactUiStyles();
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    conversationUi.select('dm_e_fixture');
    globalThis.fixture={store,ui:conversationUi,key:conversationDraftKey,refresh:notifyConversationChanges,theme:setWandTheme,changes:0,opened:[],viewer:imageViewerController};
    function Candidates(){const [agents,setAgents]=React.useState([1,2,3].map(n=>({provider:'pi',engine:'sdk',model:'saved-model-'+n,mode:'default',kind:'structured',thinkingEffort:'off'})));return <div style={{padding:20}}>{agents.map((agent,i)=><div key={i}><AgentFields agent={agent} catalog={null} allowSdkEngine providerOptions={[{value:'pi',label:'Pi'},{value:'codex',label:'Codex'}]} ariaPrefix={'候选'+(i+1)} onChange={next=>{fixture.changes++;setAgents(values=>values.map((v,n)=>n===i?next:v))}}/></div>)}</div>}
    const cards={editCards:false,inlineTools:false,terminal:false,thinking:false};
    createRoot(document.getElementById('root')).render(<WandUiProvider><PortalContainerProvider container={document.getElementById('portals')}>{location.pathname==='/candidates'?<Candidates/>:location.pathname==='/display'?<DisplaySettingsTab snapshot={{access:'admin',config:{cardDefaults:cards}}} repository={{execute:()=>{throw new Error('No config writes')}}} refresh={async()=>{}}/>:<><ConversationHome visible sidebarOpen={false} onOpenSession={id=>fixture.opened.push(id)}/><ImageViewerHost/></>}</PortalContainerProvider></WandUiProvider>);
  `;
  const bundled = await build({ stdin: { contents: source, loader: "tsx", resolveDir: root }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const agent = { provider: "pi", engine: "sdk", model: "fixture-model", mode: "default", kind: "structured", thinkingEffort: "off" };
  const employees = [{ id: "e_fixture", name: "测试员工", agents: [agent], duty: "", createdAt: "", updatedAt: "" }, { id: "e_available", name: "可用员工", agents: [agent], duty: "", createdAt: "", updatedAt: "" }];
  let archived = false, mutations = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    if (req.method !== "GET") { mutations++; res.writeHead(403); res.end("No execution or configuration writes"); return; }
    if (path === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(bundled.outputFiles[0]!.text); return; }
    // This focused fixture does not load the independent avatar renderer chunk.
    if (path.includes("ChunkSrc")) { res.setHeader("content-type", "text/javascript"); res.end(""); return; }
    if (path === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (path.startsWith("/api/")) {
      res.setHeader("content-type", "application/json");
      let body: unknown = {};
      if (path === "/api/silicon-employees") body = { employees: employees.map(e => ({ ...e, archivedAt: e.id === "e_fixture" && archived ? "2026-01-01" : null })) };
      if (path === "/api/config") body = { defaultCwd: "/tmp/fixture-only" };
      if (path.startsWith("/api/conversations/dm_")) body = { id: path.split("/").at(-1), kind: "dm", title: "测试员工", peerEmployeeId: path.endsWith("e_available") ? "e_available" : "e_fixture", updatedAt: String(archived), team: null, tasks: [], runDetails: [], unavailableReason: archived && path.endsWith("e_fixture") ? "员工已归档，无法接收新工作。" : "", messages: [
        ...["验收", "字", "🐈", "https://example.invalid/" + "a".repeat(150)].map((text, i) => ({ messageId: String(i), role: "user", content: [{ type: "text", text }], createdAt: "2026-01-01T14:03:00Z" })),
        { messageId: "error", role: "assistant", content: [], sessionLink: { sessionId: "fixture-session", title: "错误工作的历史与需要明确继续的长标题".repeat(20) }, sessionPreview: { status: "failed", text: "Model not found: fixture/model\n/tmp/private/runtime.js:42\n\nModel not found: fixture/model\n/tmp/private/runtime.js:42" } },
      ] };
      if (path === "/api/conversations" || path === "/api/ai-teams") body = path.endsWith("conversations") ? { conversations: [] } : [];
      if (path.startsWith("/api/sessions/")) body = { id: "fixture-session", status: "failed", cwd: "/tmp/fixture-only", messages: [] };
      res.end(JSON.stringify(body)); return;
    }
    res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}`, 1280, 900);
  const cases: unknown[] = [];
  try {
    await browser.wait("!!document.querySelector('.conversation-sender textarea') && !!document.querySelector('.conversation-execution-failure')");
    for (const width of [1280, 640, 501, 500, 390, 320]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.settle();
      const bubbles = await browser.evaluate(`Array.from(document.querySelectorAll('.conversation-message')).map(n=>{const t=n.querySelector('time'),b=n.querySelector('.team-chat-body-text');return {text:b?.textContent,width:b?.getBoundingClientRect().width,height:b?.getBoundingClientRect().height,timeWidth:t?.getBoundingClientRect().width,timeHeight:t?.getBoundingClientRect().height,whiteSpace:t&&getComputedStyle(t).whiteSpace}})`);
      assert.ok(bubbles[0].width >= 30, `${width}: two Chinese characters fit horizontally`);
      assert.ok(bubbles.every((b: any) => b.timeWidth >= 25 && b.timeHeight <= 20 && b.whiteSpace === "nowrap"), `${width}: clocks never shrink or wrap`);
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      await browser.click(".conversation-config-trigger");
      const continued = await browser.evaluate("(()=>{const n=document.querySelector('.conversation-continue-work'),p=n.querySelector('.conversation-continue-prefix'),t=n.querySelector('.conversation-continue-title'),b=n.getBoundingClientRect(),r=p.getBoundingClientRect();return {prefix:p.textContent,prefixInside:r.left>=b.left&&r.right<=b.right,titleOverflow:getComputedStyle(t).textOverflow,titleWidth:t.getBoundingClientRect().width,label:n.getAttribute('aria-label')}})()");
      assert.equal(continued.prefixInside,true,`${width}: continue prefix is fully visible`);
      assert.equal(continued.prefix,'继续：');assert.equal(continued.titleOverflow,'ellipsis');assert.ok(continued.titleWidth>20);assert.ok(continued.label.length>100);
      cases.push({ width, bubbles, continued });
      await browser.key("Escape");
      if ([320,390,500,501].includes(width)) await browser.screenshot(join(output, `continue-title-${width}.png`));
    }
    await browser.click(".conversation-sender textarea");
    const long = Array.from({ length: 36 }, (_, i) => `${i + 1}. 长草稿检查：保留焦点、光标、滚动和附件，不触发发送。`).join("\n");
    await browser.send("Input.insertText", { text: long });
    await browser.evaluate("window.originalInput=document.querySelector('.conversation-sender textarea');originalInput.setSelectionRange(originalInput.value.length,originalInput.value.length);true");
    const compact = await browser.evaluate("originalInput.clientHeight");
    await browser.click(".composer-expand-editor");
    assert.ok(await browser.evaluate("originalInput.clientHeight") > compact);
    assert.equal(await browser.evaluate("document.activeElement===originalInput && originalInput===document.querySelector('.conversation-sender textarea') && originalInput.selectionEnd===originalInput.value.length"), true);
    await browser.screenshot(join(output, "long-draft-320.png"));
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 500, height: 500, deviceScaleFactor: 1, mobile: false });
    await browser.settle();
    await browser.screenshot(join(output, "short-window-expanded.png"));
    assert.equal(await browser.evaluate("(()=>{const r=document.querySelector('.conversation-submit').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0})()"), true, "send stays reachable in a short window");
    await browser.click(".composer-expand-editor");
    assert.equal(await browser.evaluate("originalInput.value"), long);
    await browser.click(".conversation-config-trigger");
    await browser.click(".conversation-continue-work");
    assert.equal(await browser.evaluate("fixture.opened.at(-1)"), "fixture-session");
    assert.equal(await browser.evaluate("originalInput.value"), long, "continue navigation preserves the new-work draft");
    await browser.key("Escape");
    await browser.click(".conversation-config-trigger");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-preference-details').textContent.includes('/tmp/fixture-only')"),true);
    assert.equal(await browser.evaluate("document.querySelector('.conversation-preference-details').textContent.includes('fixture-model')"),true);
    await browser.key("Escape");
    await browser.click('[aria-label="更多聊天操作"]');
    await browser.click('[aria-label="临时聊天目录（本页共用）"]');
    await browser.send("Input.insertText", {text:"/tmp/temporary-fixture"});
    await browser.key("Escape");
    await browser.evaluate("fixture.ui.select('dm_e_available');true");
    await browser.settle();
    await browser.click(".conversation-config-trigger");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-preference-details').textContent.includes('/tmp/temporary-fixture')"),true);
    await browser.key("Escape");
    await browser.evaluate("fixture.ui.select('dm_e_fixture');true");
    await browser.settle();
    assert.equal(await browser.evaluate("document.querySelector('.conversation-sender textarea').value"),long);
    await browser.key("Escape");
    await browser.click('[aria-label="更多聊天操作"]');
    await browser.evaluate("Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='清除临时目录').click();true");
    await browser.key("Escape");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-config-trigger').textContent.includes('临时目录')"),false);
    cases.push({newWorkDraftPreserved:true,continueTarget:'fixture-session',defaultPreference:true,pageWideCwdOverride:true,clearedOverride:true});
    await browser.evaluate(`(()=>{const key=fixture.key('dm_e_fixture',null);for(let i=1;i<=3;i++){const previewUrl='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="'+['tan','teal','pink'][i-1]+'"/></svg>');fixture.store.edit(key,{addAttachment:{name:'wand-audit-'+i+'.png',size:200,file:new File(['fixture'],'image.png',{type:'image/png'}),previewUrl}})}fixture.store.edit(key,{addAttachment:{name:'长文件名称'.repeat(20)+'.txt',size:100,file:new File(['fixture'],'text.txt')}});return true})()`);
    await browser.settle();
    await browser.click('[aria-label="预览附件 wand-audit-2.png"]');
    await browser.wait("document.querySelector('.wand-image-viewer [role=status]')?.textContent.includes('2 / 3')");
    assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('.wand-image-viewer button')).filter(n=>/switch-|actions-action-zoom/.test(n.className)).map(n=>n.getAttribute('aria-label')).sort()"),["上一张图片","下一张图片","放大图片","缩小图片"].sort());
    await browser.key("ArrowRight");
    await browser.wait("document.querySelector('.wand-image-viewer [role=status]')?.textContent.includes('3 / 3')");
    await browser.click(".wand-image-viewer .ant-image-preview-close");
    await browser.wait("!document.querySelector('.wand-image-viewer') || getComputedStyle(document.querySelector('.wand-image-viewer')).display==='none'");
    await browser.wait("document.activeElement.getAttribute('aria-label')==='预览附件 wand-audit-2.png'", "thumbnail focus after actual lazy viewer close");
    await browser.click('[aria-label="预览附件 wand-audit-1.png"]'); await browser.key("Escape");
    await browser.click('[aria-label="预览附件 wand-audit-2.png"]');
    for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, x: 5, y: 100, button: "left", clickCount: 1 });
    await browser.wait("!document.querySelector('.wand-image-viewer') || getComputedStyle(document.querySelector('.wand-image-viewer')).display==='none'");
    const remove = await browser.evaluate("(()=>{const n=document.querySelector('[aria-label^=\"移除附件\"]');n.focus();const r=n.getBoundingClientRect();return {opacity:getComputedStyle(n).opacity,width:r.width,height:r.height}})()");
    assert.equal(remove.opacity, "1"); assert.ok(remove.width >= 32 && remove.height >= 32);
    await browser.key("Enter");
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_fixture',null)).attachments.length"), 3);
    assert.equal(await browser.evaluate("originalInput.value"), long);
    await browser.evaluate("window.removedPreview=fixture.store.read(fixture.key('dm_e_fixture',null)).attachments[0];true");
    await browser.click('[aria-label="预览附件 wand-audit-2.png"]');
    await browser.wait("!!document.querySelector('.wand-image-viewer [role=status]')");
    await browser.evaluate("fixture.store.edit(fixture.key('dm_e_fixture',null),{removeAttachment:0});true");
    await browser.key("Escape");
    await browser.wait("document.activeElement.getAttribute('aria-label')==='预览附件 wand-audit-3.png'", "removed preview returns to remaining thumbnail");
    await browser.evaluate("fixture.store.edit(fixture.key('dm_e_fixture',null),{addAttachment:removedPreview});window.retainedAttachments=fixture.store.read(fixture.key('dm_e_fixture',null)).attachments;true");
    await browser.click('[aria-label="预览附件 wand-audit-2.png"]');
    await browser.wait("!!document.querySelector('.wand-image-viewer [role=status]')");
    await browser.evaluate("for(let i=retainedAttachments.length-1;i>=0;i--)fixture.store.edit(fixture.key('dm_e_fixture',null),{removeAttachment:i});true");
    await browser.click(".wand-image-viewer .ant-image-preview-close");
    await browser.wait("document.activeElement===originalInput", "removed attachment list returns to the same composer input");
    assert.equal(await browser.evaluate("originalInput.value"),long);
    await browser.evaluate("for(const a of retainedAttachments)fixture.store.edit(fixture.key('dm_e_fixture',null),{addAttachment:a});true");
    cases.push({lazyFirstCloseFocus:true,repeatedOpenFocus:true,removedPreviewFallback:true,removedListInputFallback:true});
    await browser.screenshot(join(output, "attachments-500.png"));
    assert.equal(await browser.evaluate("document.querySelector('.conversation-submit').getBoundingClientRect().bottom<=innerHeight"), true, "mixed attachments and long text keep send reachable");
    await browser.evaluate("fixture.store.edit(fixture.key('dm_e_fixture',null),{addAttachment:{name:'damaged.png',size:50,file:new File(['broken'],'damaged.png',{type:'image/png'}),previewUrl:'data:image/png;base64,YnJva2Vu'}});true");
    await browser.wait("document.querySelector('.composer-attachment-list').textContent.includes('图片无法预览')");
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_fixture',null)).attachments.length"),4,"decoding failure keeps the original file");
    await browser.evaluate("(()=>{const files=new DataTransfer();for(let i=0;i<8;i++)files.items.add(new File(['fixture'],'extra-'+i+'.txt'));const input=document.querySelector('input[type=file]');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    await browser.wait("document.querySelector('.conversation-feedback').textContent.includes('最多添加 5 个附件')");
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_fixture',null)).attachments.length"),4,"over-limit selection preserves the current draft");
    archived = true; await browser.evaluate("fixture.refresh();true");
    await browser.wait("document.querySelector('.conversation-sender textarea').readOnly");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"添加附件\"]').disabled"), true);
    assert.equal(await browser.evaluate("originalInput.value"), long);
    await browser.screenshot(join(output, "archived-draft.png"));
    for(const theme of ['warm','blue','forest','mauve','graphite']) {
      await browser.evaluate(`fixture.theme(${JSON.stringify(theme)});true`);await browser.settle();
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true);
      cases.push({theme,archivedDraftPreserved:await browser.evaluate("originalInput.value.length")});
    }
    await browser.evaluate("fixture.store.edit(fixture.key('dm_e_available',null),{text:'目标已有草稿'});true");
    await browser.click('[aria-label="草稿转移目标员工"]');
    await browser.wait("Array.from(document.querySelectorAll('[role=option]')).some(n=>n.textContent==='可用员工')");
    await browser.evaluate("Array.from(document.querySelectorAll('[role=option]')).find(n=>n.textContent==='可用员工').dataset.transferTarget='';true");
    await browser.click('[data-transfer-target]');
    await browser.evaluate("Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='转移草稿').dataset.transferAction='';true");
    await browser.click('[data-transfer-action]');
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_fixture',null)).text"),long);
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_available',null)).text"),'目标已有草稿');
    await browser.evaluate("fixture.store.edit(fixture.key('dm_e_available',null),{text:''});true");
    await browser.click('[data-transfer-action]');
    await browser.wait("!document.querySelector('.conversation-sender textarea').readOnly");
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_fixture',null)).text"),'');
    assert.equal(await browser.evaluate("document.querySelector('.conversation-sender textarea').value"),long);
    assert.equal(await browser.evaluate("fixture.store.read(fixture.key('dm_e_available',null)).attachments.length"),4);
    cases.push({archivedTransfer:true,occupiedTargetRetained:true,sourceEmptiedOnlyAfterTransfer:true});
    await browser.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/candidates`});
    await browser.wait("document.querySelectorAll('[role=combobox]').length>=12");
    assert.equal(await browser.evaluate("document.querySelectorAll('[role=combobox][title=\"Wand Agent\"]').length"),3,"all saved SDK candidates echo the execution tool");
    assert.equal(await browser.evaluate("fixture.changes"),0,"rendering stored candidates does not dirty them");
    await browser.click('[aria-label="候选1指派给"]');
    await browser.wait("Array.from(document.querySelectorAll('[role=option]')).some(n=>n.textContent==='Wand Agent')");
    await browser.key('Escape');
    await browser.screenshot(join(output,'saved-sdk-candidates.png'));
    await browser.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/display`});
    await browser.wait("!!document.querySelector('.wand-settings-library-save-bar button')");
    const saveDisabled="document.querySelector('.wand-settings-library-save-bar button').disabled";
    assert.equal(await browser.evaluate(saveDisabled),true);
    await browser.click('.ant-switch');assert.equal(await browser.evaluate(saveDisabled),false);
    await browser.click('.ant-switch');assert.equal(await browser.evaluate(saveDisabled),true,"reverting shared display changes clears dirty state");
    assert.equal(mutations, 0); assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, cases, longDraft: long.length, remove, archivedReadOnly: true, mutations, scope: "production React in Chrome with explicit readonly API fixture; not installed acceptance" }, null, 2));
  } catch(error) {
    writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),errors:browser.errors,diagnostic:await browser.evaluate("({open:fixture.viewer.isOpen(),activeTag:document.activeElement.tagName,activeClass:document.activeElement.className,target:document.querySelector('[aria-label=\"预览附件 wand-audit-2.png\"]')?.getBoundingClientRect().toJSON()})"),body:await browser.evaluate('document.body.textContent')},null,2));
    throw error;
  } finally { await browser.close(); server.close(); }
});
