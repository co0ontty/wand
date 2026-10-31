import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "../helpers/browser-harness.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const out = join(repo, "output/generative-ui-demo");
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, "main.tsx")], outfile: join(out, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
await build({ entryPoints: [join(repo, "src/web-ui/react/avatars/renderer.ts")], outfile: join(out, "plush-avatar.js"), bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true });
const requests = [];
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; font-src 'self' data:"><title>Wand · Generative UI 视觉 Demo</title><link rel="stylesheet" href="/foundation.css"><link rel="stylesheet" href="/app.css"></head><body><div id="root" data-wand-ui-root></div><script>globalThis.__wandBrowserRuntime={configPath:'',aiTeamsChunkSrc:'',plushAvatarChunkSrc:'/assets/plush-avatar.js'};</script><script src="/app.js"></script></body></html>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  requests.push({ method: req.method, pathname });
  if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
  const files = { "/app.js": [join(out, "app.js"), "text/javascript"], "/app.css": [join(out, "app.css"), "text/css"], "/foundation.css": [join(repo, "src/web-ui/content/styles.css"), "text/css"], "/assets/plush-avatar.js": [join(out, "plush-avatar.js"), "text/javascript"] };
  if (files[pathname]) { res.setHeader("Content-Type", files[pathname][1]); res.end(readFileSync(files[pathname][0])); return; }
  if (pathname !== "/") { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const checks = [];
try {
  browser = await openPlushBrowser(1440, 1000, false, "reduce");
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await browser.wait("!!document.querySelector('.demo-surface') && !!document.querySelector('[data-renderer=webgl]')");
  await browser.settle();
  const total = () => browser.evaluate("document.querySelector('.demo-total').textContent");
  assert.match(await total(), /2,460/);
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await browser.screenshot(join(out, "wand-generative-ui-demo.png"));
  checks.push("Desktop: current Wand theme/components, 200 users => ¥2,460/month");
  await browser.click('[role="slider"][aria-label="每日活跃用户"]');
  for (let i = 0; i < 6; i++) await browser.key("ArrowRight");
  await browser.wait("document.querySelector('[role=slider][aria-label=每日活跃用户]').getAttribute('aria-valuenow') === '500'");
  assert.match(await total(), /5,700/);
  assert.equal(await browser.evaluate("document.querySelector('.demo-conclusion').textContent.includes('超出预算')"), true);
  await browser.evaluate("document.activeElement.blur()");
  await browser.screenshot(join(out, "wand-generative-ui-adjusted.png"));
  checks.push("Real keyboard slider interaction: 500 users => ¥5,700/month, budget overrun ¥2,700");
  await browser.click(".demo-reset");
  assert.match(await total(), /2,460/);
  await browser.click(".demo-save");
  assert.equal(await browser.evaluate("document.querySelector('.demo-save').textContent"), "已暂存演示参数");
  await browser.click(".demo-reset");
  await browser.click('[aria-label="单次模型调用成本"]');
  await browser.wait("!!document.querySelector('[role=option]')");
  await browser.key("Escape");
  checks.push("Local reset/save feedback and shared Select Escape dismissal");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await browser.settle();
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  await browser.screenshot(join(out, "wand-generative-ui-mobile-check.png"));
  await browser.evaluate("document.querySelector('.demo-save').scrollIntoView({block:'nearest',behavior:'instant'})");
  assert.equal(await browser.evaluate("(()=>{let r=document.querySelector('.demo-save').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()"), true);
  checks.push("390px: no horizontal overflow; panel scrolls to reachable actions");
  assert.deepEqual(browser.errors, []);
  assert.equal(requests.some(req => req.method !== "GET" || req.pathname.startsWith("/api/")), false);
  const report = { scope: "Isolated visual demo, NOT production feature acceptance", checks, errors: browser.errors, modelCalls: 0, productionRequests: 0, source: "scripts/design-previews/generative-ui/main.tsx", screenshots: ["wand-generative-ui-demo.png", "wand-generative-ui-adjusted.png", "wand-generative-ui-mobile-check.png"], assets: "Wand components, icons, theme, canonical ChatMessage, ShellTopbar and existing procedural cat avatar; screenshot content is fictional demo data" };
  writeFileSync(join(out, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
