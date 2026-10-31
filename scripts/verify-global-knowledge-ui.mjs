import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPlushBrowser } from "design-previews/helpers/browser-harness.mjs";

// Installed service, real clicks and unsaved drafts only. Never saves example conventions.
const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
const origin = new URL(connection.serverURL).origin;
const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ appToken: decoded.slice(decoded.lastIndexOf("#") + 1) }) });
assert.equal(login.status, 200);
const cookies = login.headers.getSetCookie();
const headers = { cookie: cookies.map(value => value.split(";")[0]).join("; ") };
const get = async route => { const response = await fetch(origin + route, { headers }); assert.equal(response.status, 200); return response.json(); };
const before = await get("/api/knowledge?scope=global&ownerId=global");
assert.equal(before.scope, "global");
const output = "output/global-knowledge";
mkdirSync(output, { recursive: true });
const browser = await openPlushBrowser();
const cases = [];
try {
  for (const raw of cookies) {
    const pair = raw.split(";")[0], at = pair.indexOf("=");
    await browser.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin,
      httpOnly: /HttpOnly/i.test(raw), secure: origin.startsWith("https:") });
  }
  for (const width of [1440, 390]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await browser.send("Page.navigate", { url: origin + "/?view=knowledge&knowledgeScope=global&knowledgeOwner=global" });
    const ready = "!!document.querySelector('.knowledge-directory [aria-label=新建文档]:not(:disabled)')";
    const deadline = Date.now() + 60000;
    while (!await browser.evaluate(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await browser.evaluate(ready), true, "installed knowledge page ready");
    if (width === 390 && await browser.evaluate("!!document.querySelector('.sidebar-overlay.is-open')")) {
      await browser.click("#close-drawer-button");
    }
    assert.equal(await browser.evaluate("document.querySelector('.knowledge-tabs [aria-selected=true]')?.textContent.trim()"), "全局");
    assert.equal(await browser.evaluate("document.querySelector('.directory-tools').textContent.includes('所有员工、项目与 CLI')"), true);
    assert.equal(await browser.evaluate("!!document.querySelector('.directory-tools [aria-label=选择员工]')"), false);
    await browser.click('.knowledge-directory [aria-label="新建文档"]');
    await browser.click('[aria-label="文档标题"]');
    await browser.send("Input.insertText", { text: "未保存的全局规则验收草稿" });
    await browser.click('[aria-label="文档正文"]');
    await browser.send("Input.insertText", { text: "浏览器操作使用 ego lite（验收草稿，不保存）" });
    await browser.clickText("预览正文");
    assert.equal(await browser.evaluate("document.querySelector('.document-paper').textContent.includes('ego lite')"), true);
    await browser.clickText("继续编辑");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=文档正文]').value.includes('ego lite')"), true);
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await browser.screenshot(join(output, `installed-${width}.png`));
    await browser.clickText("取消");
    await browser.clickText("放弃修改");
    await browser.wait("!document.querySelector('[aria-label=文档正文]')");
    cases.push({ width, scope: "global", draftAndPreview: true, discard: true, overflow: false });
  }
  const after = await get("/api/knowledge?scope=global&ownerId=global");
  assert.deepEqual(after.entries, before.entries);
  const mutations = browser.events.filter(event => event.method === "Network.requestWillBeSent"
    && !["GET", "HEAD", "OPTIONS"].includes(event.params.request.method));
  assert.equal(mutations.length, 0);
  assert.equal(browser.errors.length, 0);
  writeFileSync(join(output, "installed-result.json"), JSON.stringify({ cases, mutations: 0, pageErrors: 0, knowledgeUnchanged: true }, null, 2));
  console.log(JSON.stringify({ cases, mutations: 0, pageErrors: 0, knowledgeUnchanged: true }));
} catch (error) {
  await browser.screenshot(join(output, "installed-failure.png"));
  writeFileSync(join(output, "installed-failure.json"), JSON.stringify({ error: String(error), pageErrors: browser.errors,
    knowledge: await browser.evaluate("document.querySelector('.wand-knowledge-page')?.innerText ?? 'knowledge page missing'") }, null, 2));
  throw error;
} finally { await browser.close(); }
