import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { output } from "./build.mjs";
import { openPlushBrowser, closeFixtureServer } from "../helpers/browser-harness.mjs";

const requests = [], cases = [];
const html = readFileSync(join(output, "index.html"));
const server = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url });
  if (req.method !== "GET" || req.url !== "/") { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await openPlushBrowser(1440, 1100, false, "no-preference");
  let previewURL = `http://127.0.0.1:${server.address().port}/`;
  if (process.argv.includes("--installed")) {
    const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
    const origin = new URL(connection.serverURL).origin;
    const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
    const appToken = decoded.slice(decoded.lastIndexOf("#") + 1);
    const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appToken }) });
    assert.equal(login.status, 200, "installed preview login");
    for (const cookie of login.headers.getSetCookie()) {
      const pair = cookie.split(";")[0], at = pair.indexOf("=");
      await browser.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin, httpOnly: /HttpOnly/i.test(cookie), secure: origin.startsWith("https:") });
    }
    previewURL = origin + "/api/local-file/" + Buffer.from(join(output, "index.html")).toString("base64url") + "/";
  }
  await browser.send("Page.navigate", { url: previewURL });
  await browser.wait("!!document.querySelector('.review-preview')");
  const e = async expression => {
    try { return await browser.evaluate(expression); }
    catch (error) { throw new Error(`Preview evaluation failed at ${expression.slice(0, 180)}`, { cause: error }); }
  };
  const stage = async expected => assert.equal(await e("document.querySelector('[data-testid=stage]').textContent"), expected);
  const action = name => browser.click(`[data-action=${name}]`);
  const fill = async (label, value) => {
    await browser.click(`[aria-label="${label}"]`);
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65, commands: ["selectAll"] });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65 });
    await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    if (value) await browser.send("Input.insertText", { text: value });
    await browser.settle();
    assert.equal(await e(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).value`), value, `real keyboard editing: ${label}`);
  };
  await stage("执行中");
  await action("submit");
  assert.match(await e("document.querySelector('[role=status]').textContent"), /请填写交付证据/);
  await fill("交付与验收证据", "示例报告与版本，非生产验收");
  await e("window.originalEvidenceNode = document.querySelector('[aria-label=交付与验收证据]'); true");
  const boxes = () => e("[...document.querySelectorAll('.review-actions button')].map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})");
  const before = await boxes();
  await action("submit"); await stage("待验收");
  assert.deepEqual(await boxes(), before, "submit feedback must not move the action buttons");
  assert.equal(await e("window.originalEvidenceNode === document.querySelector('[aria-label=交付与验收证据]')"), true);
  await fill("缺口或退回原因", "窄屏按钮不可达");
  await action("pass"); await stage("待验收");
  assert.match(await e("document.querySelector('[role=status]').textContent"), /不能遗留/);
  await action("fail"); await stage("执行中");
  assert.equal(await e("document.querySelector('[aria-label=缺口或退回原因]').value"), "窄屏按钮不可达");
  await fill("缺口或退回原因", "");
  await action("submit"); await stage("待验收");
  await action("pass"); await stage("待归档");
  assert.match(await e("document.querySelector('[data-testid=ownership]').textContent"), /人工：未确认/);
  await fill("缺口或退回原因", "人工体验仍需修复");
  await action("return"); await stage("执行中");
  await fill("缺口或退回原因", "");
  await action("submit"); await action("pass"); await action("archive"); await stage("已归档");
  assert.match(await e("document.querySelector('[data-testid=ownership]').textContent"), /人工：已确认/);
  assert.equal(await e("document.querySelectorAll('.review-column .review-card').length"), 2);
  await browser.click(".review-workbench .ant-collapse-header");
  await browser.wait("document.querySelector('.review-workbench').textContent.includes('窄屏按钮不可达')");
  await browser.key("Escape");
  cases.push("证据与缺口校验、AI退回、重新验收、人工退回、确认归档、旧结论保留、按钮几何与输入节点保留");
  // Switch examples and back: drafts remain with the owning task, not the selected card.
  await browser.click('.ant-segmented-item-label[title="DEMO-02"]');
  await fill("交付与验收证据", "DEMO-02 独立草稿");
  await browser.click('.ant-segmented-item-label[title="DEMO-03"]');
  await stage("待归档");
  await browser.click('.ant-segmented-item-label[title="DEMO-02"]');
  assert.equal(await e("document.querySelector('[aria-label=交付与验收证据]').value"), "DEMO-02 独立草稿");
  cases.push("任务间草稿隔离、切换后保留");
  for (const width of [1440, 390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await e("scrollTo(0,0)"); await browser.settle();
    assert.equal(await e("document.documentElement.scrollWidth<=innerWidth"), true, `${width}: document overflow`);
    assert.equal(await e("[...document.querySelectorAll('.review-actions button')].every(n=>{const r=n.getBoundingClientRect();return r.width>=44 && r.height>=44})"), true);
    await browser.screenshot(join(output, `${process.argv.includes("--installed") ? "installed-" : ""}preview-${width}.png`));
    cases.push(`${width}px：无页面横溢出，动作命中区≥44px，看板仅内部横滚`);
  }
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await e("matchMedia('(prefers-reduced-motion:reduce)').matches"), true);
  await browser.click('.ant-segmented-item-label[title="DEMO-03"]');
  await action("archive"); await stage("已归档");
  cases.push("减动效下人工确认路径可用");
  assert.deepEqual(browser.errors, []);
  assert.ok(requests.every(req => req.method === "GET" && req.path === "/"));
  const apiRequests = browser.events.filter(event => event.method === "Network.requestWillBeSent" && new URL(event.params.request.url).pathname.startsWith("/api/") && !event.params.request.url.startsWith(previewURL));
  assert.equal(apiRequests.length, 0);
  writeFileSync(join(output, process.argv.includes("--installed") ? "installed-verification.json" : "verification.json"), JSON.stringify({ ok: true, scope: process.argv.includes("--installed") ? "isolated preview served by installed Wand, NOT production state-machine acceptance" : "isolated interactive design preview, NOT production acceptance", cases, errors: browser.errors, apiRequests: 0, modelCalls: 0, productionWrites: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, cases, apiRequests: 0, modelCalls: 0, productionWrites: 0 }, null, 2));
} finally {
  try { if (browser) await browser.close(); }
  finally { await closeFixtureServer(server); }
}
