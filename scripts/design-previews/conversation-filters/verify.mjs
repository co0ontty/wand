import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { output } from "./build.mjs";
import { openPlushBrowser, closeFixtureServer } from "../helpers/browser-harness.mjs";
const html = readFileSync(join(output, "index.html"));
const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const cases = [];
try {
  browser = await openPlushBrowser(1660, 1080, false, process.argv.includes("--reduce") ? "reduce" : "no-preference");
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await browser.wait("document.querySelectorAll('.platform').length === 4");
  await browser.settle();
  const e = expression => browser.evaluate(expression);
  // Keep visible anchored popovers stationary; the generic harness centers every target,
  // scrolling the page between measurement and pointer dispatch.
  browser.click = async selector => {
    const target = JSON.stringify(selector);
    await e(`(()=>{const n=document.querySelector(${target});if(!n)throw Error('Missing target');const r=n.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)n.scrollIntoView({block:'nearest',behavior:'instant'});})()`);
    await browser.settle();
    await browser.wait(`(()=>{const n=document.querySelector(${target});if(!n)return false;const r=n.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(n===hit||n.contains(hit));})()`);
    const point = await e(`(()=>{const r=document.querySelector(${target}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    await browser.settle();
  };
  const screenshot = async name => {
    await browser.settle();
    const image = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(output, name), Buffer.from(image.data, "base64"));
  };
  const noOverflow = async () => assert.equal(await e("document.documentElement.scrollWidth <= innerWidth"), true, "page must fit viewport");
  await noOverflow();
  await screenshot("four-platforms-default.png");
  for (const platform of ["web", "mac", "ios", "android"]) {
    const box = () => e(`(()=>{const r=document.querySelector('[data-filter=${platform}]').getBoundingClientRect();return [r.x+scrollX,r.y+scrollY,r.width,r.height]})()`);
    const before = await box();
    await browser.click(`[data-filter=${platform}]`);
    await browser.wait("document.querySelector('.filter-panel')?.getBoundingClientRect().y >= 0");
    await browser.click('.filter-panel label:has(input[value="待验收"])');
    const label = { web: "Web", mac: "macOS", ios: "iOS", android: "Android" }[platform];
    await browser.click(`[aria-label="${label} 查找工作区"]`);
    await browser.send("Input.insertText", { text: "Wand" });
    await browser.settle();
    await browser.wait("document.querySelector('.filter-panel')?.getBoundingClientRect().y >= 0");
    assert.equal(await e("!!document.querySelector('.filter-panel')"), true, "nested workspace search retains parent");
    await browser.click('.workspace-options label:has(input[value="Wand"])');
    assert.equal(await e("document.querySelector('.workspace-options input[value=\"Wand\"]').checked"), true, platform + " workspace selected");
    assert.equal(await e("!!document.querySelector('.filter-panel')"), true, "choosing workspace retains parent");
    await browser.wait("document.querySelector('.filter-panel')?.getBoundingClientRect().y >= 0");
    await browser.click(`[data-apply=${platform}]`);
    await browser.wait("!document.querySelector('.filter-panel')");
    assert.match(await e(`document.querySelector('[data-platform=${platform}] .filter-summary').textContent`), /待验收.*Wand/);
    assert.match(await e(`document.querySelector('[data-platform=${platform}] .result-count').textContent`), /2 个对话 · 2 条关联会话匹配/);
    assert.deepEqual(await box(), before, "trigger does not move or resize");
    await browser.click(`[data-filter=${platform}]`);
    await browser.key("Escape");
    await browser.wait("!document.querySelector('.filter-panel')");
    cases.push(`${platform}: in-panel searchable workspace selection, status AND workspace, accurate example counts, apply/escape, stable trigger`);
  }
  await browser.click('.board-controls label:has(input[value="filtered"])');
  await e("scrollTo(0,0)");
  await screenshot("four-platforms-filtered.png");
  await browser.click('[data-filter=ios]');
  await screenshot("four-platforms-panel.png");
  await browser.click(".board-heading h1");
  await browser.wait("!document.querySelector('.filter-panel')");
  cases.push("outside click dismisses panel");
  await browser.click('[data-filter=web]');
  await browser.click('.filter-panel label:has(input[value="待立项"])');
  await browser.click('[data-apply=web]');
  assert.equal(await e("!!document.querySelector('[data-platform=web] .empty')"), true);
  await browser.click('[data-reset=web]');
  assert.match(await e("document.querySelector('[data-platform=web] .result-count').textContent"), /4 个对话 · 8 条关联会话/);
  cases.push("empty intersection and clear restore example list");
  for (const width of [390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await e("scrollTo(0,0)"); await browser.settle(); await noOverflow();
    await browser.click('[data-filter=ios]');
    await browser.settle();
    assert.equal(await e("(()=>{const r=document.querySelector('.filter-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()"), true);
    await browser.key("Escape");
    cases.push(`${width}px: no page or popup horizontal overflow`);
  }
  assert.deepEqual(browser.errors, []);
  writeFileSync(join(output, process.argv.includes("--reduce") ? "verification-reduced.json" : "verification.json"), JSON.stringify({ ok: true, cases, scope: "Chrome design prototype only, not native application acceptance" }, null, 2));
  console.log(JSON.stringify({ ok: true, cases }, null, 2));
} catch (error) {
  if (browser) {
    const shot = await browser.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(output,"debug-failure.png"),Buffer.from(shot.data,"base64"));
    console.log(await browser.evaluate("(()=>{const n=document.querySelector('.filter-panel label:has(input[value=\"待验收\"])');if(!n)return null;const r=n.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),hit:hit?.outerHTML.slice(0,500)}})()"));
  }
  throw error;
} finally {
  try { await browser?.close(); } finally { await closeFixtureServer(server); }
}
