import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "output/feedback-web"); mkdirSync(output, { recursive: true });
const built = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from "react"; import {createRoot} from "react-dom/client";
import {WandUiProvider} from "./src/web-ui/react/theme";
import {TaskComments} from "./src/web-ui/react/issues/task-comments";
import {configureClientFeedback,reportClientError,installClientFeedbackHandlers,feedbackFeatureForPath} from "./src/web-ui/client-feedback";
import {parseJsonResponse} from "./src/web-ui/react/http-adapter";
window.fixture={ready:false,secure:true,id:"a",revision:"1",exception:0};
configureClientFeedback({ready:()=>window.fixture.ready,version:()=>"4.99.0-beta.1",secure:()=>window.fixture.secure,fetch:(...args)=>fetch(...args)});
installClientFeedbackHandlers(window);
window.report=(event,name,message,feature)=>{const e=new Error(message);e.name=name;reportClientError(event,e,feature)};
window.apiFailure=()=>fetch("/api/sessions/fail").then(parseJsonResponse).catch(()=>{});
window.family=feedbackFeatureForPath;
function App(){const[id,setId]=React.useState("a"),[rev,setRev]=React.useState("1");React.useEffect(()=>{window.switchTask=(value)=>setId(value);window.refresh=()=>setRev(v=>v+"x")},[]);return <WandUiProvider><input aria-label="保留草稿" defaultValue="不要覆盖当前输入"/><TaskComments taskId={id} updatedAt={rev}/></WandUiProvider>}
createRoot(document.getElementById("root")).render(<App/>);` }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
const script = built.outputFiles[0].text;
let posts = [], cookies = [], failFeedback = false, lateA = null, deferA = false, comments = { a: [], b: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(script); return; }
  if (url.pathname === "/api/feedback/client") {
    let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
      posts.push(JSON.parse(body)); cookies.push(req.headers.cookie ?? "");
      res.writeHead(failFeedback ? 503 : 202, { "Content-Type": "application/json" }); res.end(JSON.stringify({ accepted: !failFeedback }));
    }); return;
  }
  if (url.pathname === "/api/sessions/fail") { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Original service error: ENOSPC" })); return; }
  const match = url.pathname.match(/^\/api\/wand-tasks\/([^/]+)\/comments$/);
  if (match) {
    const id = match[1];
    const send = () => { if (res.destroyed) return; res.writeHead(id === "legacy" ? 404 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ comments: comments[id] ?? [] })); };
    if (id === "a" && deferA) { lateA = send; return; }
    send(); return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "fixture-auth=yes; SameSite=Strict" });
  res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="root" style="padding:16px;max-width:100%;box-sizing:border-box"></main><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await openPlushBrowser(1280, 900);
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  await browser.send("Page.navigate", { url: base }); await browser.wait('typeof window.report === "function" && !!document.querySelector("input")');
  await browser.evaluate('report("update_failed","NotLoggedIn","before login","app_update")'); await browser.settle();
  assert.equal(posts.length, 0, "no diagnostics before login");
  await browser.evaluate('fixture.ready=true;fixture.secure=false;report("update_failed","Insecure","remote HTTP disabled","app_update")'); await browser.settle();
  assert.equal(posts.length, 0, "no raw diagnostics over non-loopback HTTP");
  await browser.evaluate('fixture.secure=true;report("update_failed","UpdateIOException","Original download error: ENOSPC; token=fixture-secret","app_update")');
  await browser.wait('true'); for (let n = 0; n < 100 && !posts.length; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(posts.length, 1); assert.equal(posts[0].feature, "app_update"); assert.equal(posts[0].source, "web");
  assert.match(posts[0].error.message, /Original download error: ENOSPC/); assert.doesNotMatch(JSON.stringify(posts[0]), /fixture-secret/);
  assert.match(cookies[0], /fixture-auth=yes/); assert.equal("username" in posts[0], false);
  await browser.evaluate('report("update_failed","UpdateIOException","same family","app_update")'); await browser.settle(); assert.equal(posts.length, 1, "dedup is bounded at the client");
  failFeedback = true;
  await browser.evaluate('report("websocket_error","SocketError","Original websocket fault","realtime")'); await browser.settle();
  assert.equal(posts.length, 2); await browser.settle(); assert.equal(posts.length, 2, "feedback 503 does not recursively report itself");
  await browser.evaluate('apiFailure()'); await browser.settle(); assert.equal(posts.length, 3); assert.equal(posts[2].feature, "sessions");
  assert.equal(posts[2].error.message, "Original service error: ENOSPC");
  await browser.evaluate('window.dispatchEvent(new ErrorEvent("error",{error:new TypeError("Original unhandled fixture error")}))'); await browser.settle();
  assert.equal(posts.length, 4); assert.equal(posts[3].event, "uncaught_exception");
  await browser.click('input');
  comments.a = [{ id: "c1", taskId: "a", authorName: "自定义小李", body: "【自定义小李】也遇到了相同的问题。", createdAt: "2026-10-16T03:00:00.000Z" }];
  await browser.evaluate('refresh()'); await browser.wait('document.querySelector("[aria-label=任务评论]")?.textContent.includes("自定义小李")');
  assert.equal(await browser.evaluate('document.activeElement === document.querySelector("input")'), true);
  assert.equal(await browser.evaluate('document.querySelector("input").value'), "不要覆盖当前输入");
  await browser.screenshot(resolve(output, "desktop-comments.png"));
  deferA = true; await browser.evaluate('refresh()');
  for (let n = 0; n < 100 && !lateA; n++) await new Promise(r => setTimeout(r, 10)); assert.ok(lateA);
  comments.b = [{ id: "c2", taskId: "b", authorName: "自定义小张", body: "【自定义小张】也遇到了相同的问题。", createdAt: "2026-10-16T03:01:00.000Z" }];
  await browser.evaluate('switchTask("b")'); await browser.wait('document.querySelector("[aria-label=任务评论]")?.textContent.includes("自定义小张")');
  lateA(); lateA = null; await browser.settle(); assert.doesNotMatch(await browser.evaluate('document.querySelector("[aria-label=任务评论]").textContent'), /自定义小李/);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await browser.settle();
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await browser.screenshot(resolve(output, "narrow-comments.png"));
  await browser.evaluate('switchTask("legacy")'); await browser.wait('document.querySelector("[aria-label=任务评论]")?.textContent.includes("暂无评论")');
  assert.equal(browser.errors.length, 0);
  const evidence = { actualBrowser: "Chrome headless", productionComponents: true, isolatedFixture: true, authenticatedTransport: true, rawErrorPreserved: true, credentialsRedacted: true, feedbackDoesNotRecurse: true, stableFeature: true, customNameComment: true, lateTaskIsolation: true, focusAndDraftPreserved: true, narrowNoOverflow: true, legacy404: true, posts: posts.length, errors: browser.errors.length };
  writeFileSync(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally {
  lateA?.(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
