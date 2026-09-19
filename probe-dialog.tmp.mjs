import { chromium } from 'playwright';
import fs from 'node:fs';
const token = process.argv[2];
(async () => {
  const exe = '/Users/co0ontty/Library/Caches/ms-playwright/chromium-1244/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const browser = await chromium.launch({ executablePath: fs.existsSync(exe) ? exe : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'wand_session_local', value: token, domain: '127.0.0.1', path: '/' }]);
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text().slice(0,300)));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  await page.goto('http://127.0.0.1:8181/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  console.log('badge title:', await page.evaluate(() => { const b=document.getElementById('topbar-git-badge'); return b && b.getAttribute('title'); }));
  await page.click('#topbar-git-badge');
  await page.waitForTimeout(2500);
  const dlg = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="quick-commit-dialog"]');
    return d ? d.innerText.slice(0, 1200) : 'no dialog';
  });
  console.log('--- dialog ---'); console.log(dlg);
  console.log('--- logs ---'); console.log(logs.slice(0,25).join('\n'));
  await browser.close();
})();
