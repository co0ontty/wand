import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "../helpers/browser-harness.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const out = join(repo, "output/session-status-glyph/web");
mkdirSync(out, { recursive: true });

const source = `
import * as React from 'react'; import {createRoot} from 'react-dom/client'; import { theme as antTheme } from 'antd';
import { TaskStatusGlyph } from './src/web-ui/react/workspaces/task-status-glyph';
import { WAND_PALETTES, paletteThemeConfig, themeAliases, themeCss, wandPalette } from './src/web-ui/react/theme-palettes';
import { installReactUiStyles } from './src/web-ui/react/styles';
import { classNames } from './src/web-ui/react/ui/class-names';
installReactUiStyles();

const STATES = ['running', 'queued', 'attention', 'completed', 'failed'] as const;
const LABELS: Record<string, string> = { running: '运行中', queued: '排队中', attention: '等你处理', completed: '刚完成', failed: '失败' };
const SIZES = [13, 15, 18];

function scopedTheme(id: string, selector: string): string {
  const p = wandPalette(id as never);
  const token = antTheme.getDesignToken(paletteThemeConfig(p, antTheme.darkAlgorithm));
  return themeCss(themeAliases(token, p)).replace(':root', selector);
}

const WARM = scopedTheme('warm', '.band:not(.dark)');
const DARK = scopedTheme('graphite', '.band.dark');
for (const style of [WARM, DARK]) { const el = document.createElement('style'); el.textContent = style; document.head.appendChild(el); }

function Grid({ theme, tone }: { theme: string; tone: 'normal' | 'gray' | 'contrast' }) {
  return (
    <section className={classNames('sheet', 'tone-' + tone)} style={{ filter: tone === 'gray' ? 'grayscale(1) brightness(1.05)' : undefined }}>
      <h2>{theme === 'warm' ? '暖白铜色 · 浅色' : '深色石墨 · 深色'}{tone === 'gray' ? '（灰度）' : tone === 'contrast' ? '（高对比）' : ''}</h2>
      <table>
        <thead><tr><th>状态</th>{SIZES.map(s => <th key={s}>{s}px</th>)}</tr></thead>
        <tbody>
          {STATES.map(status => (
            <tr key={status} data-state={status}>
              <th scope="row">{LABELS[status]}</th>
              {SIZES.map(s => <td key={s}><TaskStatusGlyph status={status as never} size={s} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="page">
    <div className="band"><Grid theme="warm" tone="normal" /></div>
    <div className="band dark"><Grid theme="dark" tone="normal" /></div>
    <div className="band"><Grid theme="warm" tone="gray" /></div>
    <div className="band dark"><Grid theme="dark" tone="gray" /></div>
  </div>
);
`;

await build({
  stdin: { contents: source, resolveDir: repo, loader: "tsx" }, bundle: true, platform: "browser", format: "iife",
  outfile: join(out, "sheet.js"), define: { "process.env.NODE_ENV": '"production"' },
});

const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #e8e4de; font: 13px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
.page { display: inline-block; padding: 16px; }
.band { background: var(--bg-primary, #faf8f5); color: var(--text-primary, #29241f); padding: 12px 16px; border: 1px solid var(--border-default, #ccc); }
.band.dark { border-color: #000; }
.sheet h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--text-secondary); }
.sheet table { border-collapse: collapse; }
.sheet th[scope=row] { text-align: left; font-weight: 400; font-size: 12px; color: var(--text-primary); padding: 5px 14px 5px 0; white-space: nowrap; }
.sheet thead th { text-align: left; font-weight: 400; font-size: 11px; color: var(--text-tertiary); padding: 0 18px 4px 0; }
.sheet td { padding: 5px 18px 5px 0; }
.sheet td .wand-status-glyph-wrap { outline: 1px dashed color-mix(in srgb, var(--text-tertiary, currentColor) 40%, transparent); outline-offset: 2px; }
`;

const server = createServer((request, response) => {
  const path = request.url.split("?")[0];
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (path === "/sheet.js") { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync(join(out, "sheet.js"))); return; }
  if (path === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(readFileSync(join(repo, "src/web-ui/content/styles.css"))); return; }
  if (path === "/sheet.css") { response.setHeader("Content-Type", "text/css"); response.end(css); return; }
  response.setHeader("Content-Type", "text/html;charset=utf-8");
  response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/sheet.css"></head><body><div id="root"></div><script src="/sheet.js"></script></body></html>');
});
await new Promise(done => server.listen(0, "127.0.0.1", done));

let browser;
try {
  browser = await openPlushBrowser(520, 900, false, "reduce");
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await browser.wait("document.querySelectorAll('.wand-status-glyph').length===40");
  await browser.settle();
  const measured = await browser.evaluate(`(()=>[...document.querySelectorAll('.wand-status-glyph')].map(n=>{const r=n.getBoundingClientRect();const s=getComputedStyle(n);
    return{cls:[...n.classList].find(c=>c.startsWith('is-')),w:Math.round(r.width),h:Math.round(r.height),color:s.color,bg:s.backgroundColor,anim:s.animationName}}))()`);
  const distinct = new Set(measured.filter(m => m.cls === "is-attention").map(m => `${m.color}|${m.bg}`));
  const failed = new Set(measured.filter(m => m.cls === "is-failed").map(m => `${m.color}|${m.bg}`));
  assert.ok(distinct.size === 2 && failed.size === 2, "attention and failed carry theme colours, not fallbacks");
  for (const value of distinct) assert.ok(!failed.has(value), `attention colour ${value} differs from failed`);
  await browser.evaluate("document.querySelectorAll('.sheet').forEach((s,i)=>s.dataset.index=i)");
  await browser.screenshot(join(out, "glyph-sheet.png"));
  writeFileSync(join(out, "sheet.json"), JSON.stringify({ ok: true, measured }, null, 2));
  console.log(JSON.stringify({ ok: true, glyphCount: measured.length, attention: [...distinct], failed: [...failed] }, null, 2));
} catch (error) {
  if (browser) console.log(JSON.stringify({ errors: browser.errors }, null, 2));
  throw error;
} finally {
  try { await browser?.close(); } finally { await new Promise(done => server.close(done)); }
}
