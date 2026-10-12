// Two independent Chrome clients, real HTTP/WS, production employee repository/profile owners.
// Loopback-only data; never invokes a model, installed service or native device.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const root = resolve(import.meta.dirname, "../.."), output = join(root, "output/avatar-consistency/sync-browser");
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wand-avatar-sync-"));
const OLD = "plush:v1:heart:coral:none:none", NEW = "plush:v1:round:blue:gold:none", LAST = "plush:v1:diamond:cream:ink:beret";
const person = (id, avatar) => ({ id, name: "同步员工", avatar, duty: "本地隔离验证", prompt: "不执行模型", tags: [],
  agents: [{ kind: "structured", provider: "codex", model: "default", thinkingEffort: "off" }], createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" });
const employees = [person("sync-person", OLD), person("unrelated-person", OLD)];
const reads = [], writes = [], cases = [];
let holdNext = false, held;
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
  import * as React from 'react';import {createRoot} from 'react-dom/client';
  import {employeeProfile,EmployeeProfileHost} from './src/web-ui/react/agents/employee-profile';
  import {useSiliconEmployees,notifySiliconEmployeeDefinitionChanged} from './src/web-ui/react/agents/employee-repository';
  import {WandUiProvider} from './src/web-ui/react/theme';import {PortalContainerProvider} from './src/web-ui/react/ui';
  import {installReactUiStyles} from './src/web-ui/react/styles';installReactUiStyles();
  const controls={};window.profileSync=controls;
  function connect(){const ws=new WebSocket(location.origin.replace('http','ws')+'/ws');controls.socket=ws;
    ws.onopen=()=>notifySiliconEmployeeDefinitionChanged();
    ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='notification'&&message.data?.kind==='silicon-employee-definition')notifySiliconEmployeeDefinitionChanged(message.data.employeeId)};
  }controls.connect=connect;connect();
  function App(){const {employees}=useSiliconEmployees();const [mobile,setMobile]=React.useState(innerWidth<760);
    React.useEffect(()=>{const resize=()=>setMobile(innerWidth<760);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[]);
    return <><section aria-label='隔离通讯录'>{employees.map(employee=><button key={employee.id} id={'row-'+employee.id} data-avatar={employee.avatar} onClick={event=>employeeProfile.open(employee,event.currentTarget)}>{employee.name}</button>)}</section><EmployeeProfileHost mobile={mobile}/></>;
  }
  createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('wand-react-ui-portals')}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
` }, bundle: true, jsx: "automatic", platform: "browser", format: "iife", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
await build({ entryPoints: [join(root, "src/web-ui/react/avatars/renderer.ts")], bundle: true, minify: true, format: "iife", outfile: join(temp, "plush-avatar.js") });
writeFileSync(join(temp, "app.js"), readFileSync(join(temp, "app.js"), "utf8").replaceAll("${plushAvatarChunkSrc}", "/plush-avatar.js"));
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture.invalid").pathname;
  const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
  let text = ""; if (request.method === "PUT" || request.method === "POST") for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  if (path === "/fixture/hold") { holdNext = true; return json({ ok: true }); }
  if (path === "/fixture/held") return json({ held: !!held });
  if (path === "/fixture/release") { held?.(); held = undefined; return json({ ok: true }); }
  if (path === "/api/silicon-employees") return json({ employees });
  const match = path.match(/^\/api\/silicon-employees\/([^/]+)$/);
  if (match) {
    const employee = employees.find(e => e.id === match[1]); if (!employee) return json({}, 404);
    if (request.method === "PUT") {
      Object.assign(employee, body); writes.push({ id: employee.id, ...body });
      json(employee);
      for (const client of sockets.clients) if (client.readyState === 1) client.send(JSON.stringify({ type: "notification", data: { kind: "silicon-employee-definition", employeeId: employee.id } }));
      return;
    }
    reads.push(employee.id); const snapshot = structuredClone(employee);
    if (holdNext && employee.id === "sync-person") { holdNext = false; await new Promise(release => { held = release; }); }
    return json(snapshot);
  }
  if (path.startsWith("/api/")) return json({});
  const files = { "/app.js": [join(temp, "app.js"), "text/javascript"], "/plush-avatar.js": [join(temp, "plush-avatar.js"), "text/javascript"],
    "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"] };
  if (files[path]) { response.writeHead(200, { "content-type": files[path][1] }); return response.end(readFileSync(files[path][0])); }
  response.writeHead(200, { "content-type": "text/html;charset=utf-8" }); response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});
const sockets = new WebSocketServer({ server, path: "/ws" });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const first = await openPlushBrowser(1440, 1000), second = await openPlushBrowser(800, 800);
const update = async (avatar, id = "sync-person") => second.evaluate(`fetch('/api/silicon-employees/${id}',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({avatar:${JSON.stringify(avatar)}})}).then(r=>r.status)`);
const face = "#object-profile-panel .object-profile-card [data-plush-avatar]";
const waitFace = async (shape, color) => first.wait(`(()=>{const n=document.querySelector(${JSON.stringify(face)});if(!n)return false;const c=JSON.parse(n.dataset.avatarConfig);return c.shape===${JSON.stringify(shape)}&&c.color===${JSON.stringify(color)}})()`);
const clickText = async text => {
  const selector = await first.evaluate(`(()=>{const n=[...document.querySelectorAll('#object-profile-panel button')].find(n=>n.getClientRects().length&&n.textContent.replace(/\\s/g,'')===${JSON.stringify(text)});if(!n)throw Error('missing action');n.dataset.avatarSync='';return '[data-avatar-sync]'})()`);
  await first.click(selector); await first.evaluate("document.querySelector('[data-avatar-sync]')?.removeAttribute('data-avatar-sync')");
};
try {
  for (const browser of [first, second]) { await browser.send("Page.navigate", { url: origin }); await browser.wait("!!document.querySelector('#row-sync-person')&&profileSync.socket.readyState===1"); }
  await first.click("#row-sync-person"); await waitFace("heart", "coral");
  assert.equal(await update(NEW), 200); await waitFace("round", "blue");
  assert.equal(await first.evaluate("document.querySelector('#row-sync-person').dataset.avatar"), NEW);
  cases.push("another client updates the open profile and cached directory through employee notification");
  const before = reads.filter(id => id === "sync-person").length;
  await update(NEW, "unrelated-person"); await first.settle();
  assert.equal(reads.filter(id => id === "sync-person").length, before);
  cases.push("unrelated employee notifications do not reload this profile");
  await clickText("编辑员工配置"); await first.wait("!!document.querySelector('#employee-sync-person-name')");
  const nodeId = await first.evaluate("document.querySelector('#employee-sync-person-name').dataset.nodeIdentity='original'");
  await first.click("#employee-sync-person-name"); await first.evaluate("document.querySelector('#employee-sync-person-name').select()"); await first.send("Input.insertText", { text: "未保存姓名草稿" });
  await update(LAST); await first.wait(`document.querySelector('#row-sync-person').dataset.avatar===${JSON.stringify(LAST)}`);
  assert.equal(await first.evaluate("document.querySelector('#employee-sync-person-name').value"), "未保存姓名草稿");
  assert.equal(await first.evaluate("document.querySelector('#employee-sync-person-name').dataset.nodeIdentity"), nodeId);
  await clickText("取消"); await waitFace("diamond", "cream");
  cases.push("same-identity refresh keeps dirty input and the original editor node; Cancel reveals the latest profile");
  await clickText("编辑员工配置"); await first.wait("!!document.querySelector('#employee-sync-person-name')");
  await first.click("#employee-sync-person-name"); await first.evaluate("document.querySelector('#employee-sync-person-name').select()"); await first.send("Input.insertText", { text: "本地已保存姓名" });
  await first.click(".wand-employee-save-submit"); await first.wait("!document.querySelector('#object-profile-panel [data-employee-profile]')");
  await update(OLD); await waitFace("heart", "coral");
  cases.push("a local save result no longer masks a later remote avatar update");
  await first.evaluate("profileSync.socket.close()"); await first.wait("profileSync.socket.readyState===3");
  await update(NEW); await first.settle(); await waitFace("heart", "coral");
  await first.evaluate("profileSync.connect()"); await first.wait("profileSync.socket.readyState===1"); await waitFace("round", "blue");
  cases.push("reconnect refreshes the open profile after a notification was missed offline");
  await second.evaluate("fetch('/fixture/hold',{method:'POST'}).then(r=>r.ok)");
  await update(OLD); await second.wait("fetch('/fixture/held').then(r=>r.json()).then(r=>r.held)");
  await update(LAST); await waitFace("diamond", "cream");
  await second.evaluate("fetch('/fixture/release',{method:'POST'}).then(r=>r.ok)"); await first.settle(); await waitFace("diamond", "cream");
  cases.push("a late older detail response cannot restore a stale avatar");
  await first.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
  await first.settle(); assert.equal(await first.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await first.screenshot(join(output, "profile-phone.png")); await first.key("Escape"); await first.wait("!document.querySelector('#object-profile-panel.open')");
  cases.push("phone profile remains in bounds and Escape closes it");
  assert.deepEqual(first.errors, []); assert.deepEqual(second.errors, []);
  writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, fixtureOnly: true, independentClients: 2, modelCalls: 0, cases, reads, writes }, null, 2));
  console.log(JSON.stringify({ ok: true, cases }));
} catch (error) {
  await first.screenshot(join(output, "failure.png")); writeFileSync(join(output, "failure.json"), JSON.stringify({ cases, reads, writes, error: String(error) }, null, 2)); throw error;
} finally {
  held?.(); for (const client of sockets.clients) client.terminate();
  await first.close(); await second.close(); sockets.close(); await new Promise(resolveClose => server.close(resolveClose)); rmSync(temp, { recursive: true, force: true });
}
