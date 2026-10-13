import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("compact composer retires the avatar editor's minimum height in workspace and home", {
  skip: process.env.WAND_COMPOSER_GAP_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-composer-gap-"));
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {Sender} from "@ant-design/x";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {installChatComposerStyles} from "./src/web-ui/react/chat-composer-styles";
    import {MinimalComposerEntry,useMinimalComposer} from "./src/web-ui/react/composer-sender/minimal";
    installReactUiStyles(); installChatComposerStyles();
    function Probe({home,avatar}) {
      const surface=React.useRef(null), [text,setText]=React.useState("");
      const input=()=>surface.current?.querySelector("textarea");
      const minimal=useMinimalComposer({owner:String(home)+String(avatar),input,surface:()=>surface.current,phase:"idle",pending:!!text});
      const entry=<MinimalComposerEntry text={text} attachments={0} placeholder="展开文字输入" onOpen={minimal.open}/>;
      const identity=avatar?<div className="composer-floating-avatar" aria-hidden="true"/>:null;
      const usage=<div className="composer-usage-line">测试伙伴： 空闲</div>;
      const sender=<Sender value={text} onChange={setText} autoSize={{minRows:1,maxRows:6}} suffix={false}
        styles={{root:{border:0,boxShadow:"none",borderRadius:0,background:"transparent"},content:{padding:0}}}
        footer={home?<div className="conversation-action-row">{entry}</div>:undefined} className={home?"conversation-sender":""}/>;
      if(home)return <section data-probe="home" className="conversation-root"><div ref={surface} className="conversation-input-wrap" data-composer-expanded={minimal.expanded}>{identity}{usage}{sender}</div></section>;
      return <section ref={surface} data-probe="workspace" className="input-composer" data-composer-expanded={minimal.expanded}><div className="composer-surface"><div className="composer-main-row"><div className="composer-input-wrap">{identity}{usage}<div data-composer-sender>{sender}</div></div><div className="composer-actions-left">添加</div>{entry}<div className="composer-actions-right">发送</div></div></div></section>;
    }
    window.renderGap=(avatar)=>createRoot(document.getElementById("fixture")).render(<WandUiProvider><Probe avatar={avatar}/><Probe home avatar={avatar}/></WandUiProvider>);
    window.renderGap(true);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    const files: Record<string, string> = { "/app.js": join(temp, "app.js"), "/styles.css": join(root, "src/web-ui/content/styles.css"), "/tailwind.css": join(root, "src/web-ui/content/tailwind.css") };
    if (files[path]) { res.setHeader("Content-Type", path.endsWith("js") ? "text/javascript" : "text/css"); res.end(readFileSync(files[path])); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#fixture{padding:24px}section{margin-top:100px}.conversation-root{position:relative;inset:auto;height:auto}</style></head><body><div id="fixture"></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/`, 1280, 900);
  try {
    await browser.wait("document.querySelectorAll('[data-probe] textarea').length===2");
    for (const [width, reduced, native] of [[1280, false, false], [390, false, false], [320, true, true]] as const) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await browser.evaluate(`document.documentElement.classList.toggle('is-wand-app',${native});void 0`);
      for (const kind of ["workspace", "home"]) {
        const selector = `[data-probe="${kind}"]`;
        const measure = () => browser.evaluate(`(()=>{const root=document.querySelector('${selector}'),editor=root.querySelector('${kind === "home" ? ".ant-sender-content" : "[data-composer-sender]"}'),surface=root.querySelector('${kind === "home" ? ".ant-sender" : ".composer-surface"}'),entry=root.querySelector('.composer-compact-entry');return{height:editor.getBoundingClientRect().height,gap:entry.getBoundingClientRect().top-surface.getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
        await browser.settle();
        const compact = await measure();
        assert.equal(compact.height, 0, `${kind} collapsed editor must not retain its avatar minimum height`);
        assert.ok(compact.gap <= 16, `${kind} gap ${compact.gap}px`);
        assert.equal(compact.overflow, false);
        await browser.evaluate(`window.originalGapInput=document.querySelector('${selector} textarea');void 0`);
        await browser.click(`${selector} .composer-compact-entry`);
        assert.equal(await browser.evaluate(`document.querySelector('${selector} [data-composer-expanded]')?.dataset.composerExpanded ?? document.querySelector('${selector}').dataset.composerExpanded`), "true", `${kind} opens`);
        await browser.wait("document.activeElement===originalGapInput", `${kind} focuses same editor`);
        await browser.evaluate("originalGapInput.select();void 0");
        await browser.send("Input.insertText", { text: "保留草稿\n第二行\n第三行" });
        await browser.settle();
        assert.ok((await measure()).height >= 36);
        await browser.key("Escape");
        await browser.settle();
        assert.equal((await measure()).height, 0);
        assert.equal(await browser.evaluate(`originalGapInput===document.querySelector('${selector} textarea')`), true);
        assert.equal(await browser.evaluate("originalGapInput.value"), "保留草稿\n第二行\n第三行");
        await browser.click(`${selector} .composer-compact-entry`);
        await browser.wait("document.activeElement===originalGapInput");
        await browser.key("Escape"); await browser.settle();
      }
    }
    assert.deepEqual(browser.errors, []);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(temp, { recursive: true, force: true }); }
});
