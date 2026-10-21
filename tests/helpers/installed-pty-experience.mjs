import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

// Read-only observation of existing installed PTYs. No terminal input is sent.
const out = process.env.PTY_EVIDENCE_DIR || "output/architecture-stage2/pty-experience-20261021/installed-before";
mkdirSync(out, { recursive: true });
const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
const origin = new URL(connection.serverURL).origin;
const decoded = Buffer.from(connection.connectionCode.replace(/\s/g, ""), "base64url").toString();
const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appToken: decoded.slice(decoded.lastIndexOf("#") + 1) }) });
assert.equal(login.status, 200);
const cookies = login.headers.getSetCookie();
const headers = { cookie: cookies.map(c => c.split(";")[0]).join("; ") };
const list = await (await fetch(origin + "/api/sessions", { headers })).json();
const sessions = (Array.isArray(list) ? list : list.sessions ?? []).filter(s => s.sessionKind === "pty" && s.status === "running");
const report = { cases: [], errors: [], sendsInput: false };
let browser;
try {
  browser = await openPlushBrowser(1280, 900, true);
  for (const raw of cookies) {
    const pair = raw.split(";")[0], at = pair.indexOf("=");
    await browser.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin, httpOnly: true });
  }
  await browser.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.ptyProbe={longTasks:[],frames:0,writes:0,writeChars:0,resets:0,maxWriteMs:0,resize:0};
    new PerformanceObserver(list=>{for(const e of list.getEntries())ptyProbe.longTasks.push(e.duration)}).observe({entryTypes:['longtask']});
    (function frame(){ptyProbe.frames++;requestAnimationFrame(frame)})();
    const timer=setInterval(()=>{const t=window.__wandTerminal;if(!t||t.__ptyProbed)return;t.__ptyProbed=true;
      const write=t.write.bind(t),reset=t.reset.bind(t),resize=t.resize.bind(t);
      t.write=(data,done)=>{ptyProbe.writes++;ptyProbe.writeChars+=data.length;const at=performance.now();write(data,()=>{ptyProbe.maxWriteMs=Math.max(ptyProbe.maxWriteMs,performance.now()-at);done?.()})};
      t.reset=()=>{ptyProbe.resets++;return reset()};t.resize=(...args)=>{ptyProbe.resize++;return resize(...args)};
    },10);
  ` });
  for (const session of sessions) {
    for (const width of [1280, 390]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      browser.events.splice(0);
      await browser.send("Page.navigate", { url: origin + "/?view=workspace&session=" + encodeURIComponent(session.id) + "&embed=terminal&nativeInput=1" });
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await browser.wait("!!window.__wandTerminal && !!document.querySelector('.xterm-screen')", "installed PTY ready"); break; }
          catch (error) { if (attempt === 2) throw error; }
        }
      }
      catch (error) {
        console.log(JSON.stringify({ diagnostic: await browser.evaluate(`({className:document.documentElement.className,buttons:[...document.querySelectorAll('button')].slice(-20).map(n=>n.getAttribute('aria-label')||n.title||n.textContent.slice(0,35)),title:document.title,body:document.querySelector('#output')?undefined:document.body?.innerText.slice(0,500),roots:[...document.body.children].map(n=>({tag:n.tagName,id:n.id,className:n.className})).slice(0,15),output:document.querySelector('#output')?.className,load:document.querySelector('[data-terminal-load-state]')?.textContent,term:!!window.__wandTerminal,errors:window.ptyProbe?.longTasks})`), errors: browser.errors }));
        throw error;
      }
      await browser.evaluate("new Promise(resolve=>setTimeout(resolve,4000))");
      const facts = await browser.evaluate(`(()=>{const t=window.__wandTerminal;return {probe:ptyProbe,terminals:document.querySelectorAll('.xterm').length,wraps:document.querySelectorAll('.terminal-scroll-wrap').length,cols:t.cols,rows:t.rows,bufferLines:t.buffer.active.length,visible:document.querySelector('.xterm-screen').getBoundingClientRect().height,bodyOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
      const frames = browser.events.filter(e => e.method === "Network.webSocketFrameReceived").flatMap(e => { try { return [JSON.parse(e.params.response.payloadData)]; } catch { return []; } });
      const sent = browser.events.filter(e => e.method === "Network.webSocketFrameSent").flatMap(e => { try { return [JSON.parse(e.params.response.payloadData)]; } catch { return []; } });
      assert.equal(sent.some(e => e.type === "pty_input" && e.userInput !== false), false, "only terminal protocol query replies, never user input");
      report.cases.push({ sessionId: session.id, width, ...facts, init: frames.filter(e=>e.type==="init").map(e=>({chars:e.data?.terminalState?.data?.length,pending:e.data?.terminalState?.pending?.length,cols:e.data?.terminalState?.cols,rows:e.data?.terminalState?.rows})),outputs:frames.filter(e=>e.type==="output").length,resync:sent.filter(e=>e.type==="resync").length,resizes:sent.filter(e=>e.type==="pty_resize").length });
      writeFileSync(join(out, "metrics.json"), JSON.stringify(report, null, 2));
    }
  }
  report.errors = browser.errors;
  writeFileSync(join(out, "metrics.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await fetch(origin + "/api/logout", { method: "POST", headers });
}
