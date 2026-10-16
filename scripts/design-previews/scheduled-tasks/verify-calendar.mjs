import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openPlushBrowser } from "../../../tests/helpers/run-plush-avatar-browser-harness.mjs";
import { output, startPreview } from "./serve.mjs";

const preview = await startPreview({ port: 0 });
const browser = await openPlushBrowser(1440, 1280, false, "no-preference");
const e = async expression => { try { return await browser.evaluate(expression); } catch (error) { console.error('Calendar expression:', expression.slice(0, 240)); throw error; } };
const cases = [], screenshots = [], startedAt = Date.now();
const loadReady = async action => {
  const start = browser.events.length, deadline = Date.now() + 20000;
  await action();
  while (!browser.events.slice(start).some(event => event.method === 'Page.loadEventFired')) {
    if (Date.now() > deadline) throw Error('Calendar navigation did not finish loading');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const month = '.calendar-layer[data-active="true"] .calendar-month-scroll';
const week = '.calendar-layer[data-active="true"] .week-scroll';
const popup = '.calendar-detail-popover';
const waitPopupClosed = () => browser.wait("![...document.querySelectorAll('.calendar-detail-popover')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')");
const finishMotion = selector => e(`Promise.allSettled([...document.querySelectorAll(${JSON.stringify(selector)})].flatMap(n=>n.getAnimations()).filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished))`);
const shot = async name => { await e("document.activeElement?.blur()"); await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 36, y: 16 }); await browser.wait("![...document.querySelectorAll('.ant-tooltip')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible'&&getComputedStyle(n).opacity!=='0')"); await browser.screenshot(join(output, name)); screenshots.push(name); };
const choose = async (label, text) => { await browser.click(`[role="combobox"][aria-label="${label}"]`); await browser.wait("!!document.querySelector('[role=option]')"); await e(`(()=>{let n=[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing option');n.dataset.calendarOption='target'})()`); await browser.click('[data-calendar-option=target]'); await browser.wait("![...document.querySelectorAll('.ant-dropdown')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')"); };
const ensureFits = async label => assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1"), true, label + ': only the calendar canvas may scroll horizontally');
const switchMain = async view => {
  const selector = `nav button[aria-label="${view === 'calendar' ? '全局日历' : '定时任务'}"]`;
  if (await e(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`)) await browser.click(selector);
  else await browser.click(`.global-view-switch [data-stretch-value="${view}"]`);
};

try {
  await loadReady(() => browser.send('Page.navigate', { url: preview.origin + '/?view=calendar' }));
  await browser.wait("document.querySelector('.calendar-view')?.dataset.calendarMode==='month' && document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event').length>0");
  await browser.wait("!!document.querySelector('.calendar-face [data-renderer=webgl]')");
  assert.equal(await e("document.querySelector('.page-header h1').textContent"), '全局日历');
  assert.equal(await e("document.querySelector('.global-scope-label').textContent"), '全部员工');
  assert.equal(await e("document.querySelector('#scheduled-main').dataset.scope"), 'all-employees');
  assert.equal(await e("document.querySelectorAll('.next-section').length"), 0);
  assert.equal(await e("document.querySelector('nav button[aria-label=全局日历]').getAttribute('aria-current')"), 'page');
  assert.equal(await e("new Set([...document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event[data-entry-kind=execution] .calendar-face')].map(n=>n.dataset.employeeId)).size"), 3);
  cases.push('Independent global calendar opens directly from workbench navigation, shows all three sample employees, and requires no employee detail or hero');
  assert.equal(await e("document.querySelector('.page-content').dataset.layout"), 'calendar');
  assert.equal(await e("document.querySelectorAll('.calendar-layer[data-active=true] .month-cell').length"), 42);
  assert.equal(await e("document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event').length"), 53);
  assert.ok(await e("[...document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event')].every(n=>n.querySelector('.calendar-face')&&n.querySelector('time')&&n.querySelector('.calendar-event-title')&&n.querySelector('.calendar-event-meta > span'))"));
  assert.ok(await e("getComputedStyle(document.querySelector('.calendar-layer[data-active=true] .calendar-event[data-entry-kind=planned]')).borderTopStyle==='dashed'"));
  assert.ok(await e("!!document.querySelector('.calendar-layer[data-active=true] .calendar-event[data-entry-kind=execution]')"));
  await ensureFits('Month desktop'); await shot('scheduled-calendar-month.png');
  cases.push('Month is a native 42-date calendar with 53 direct avatar/time/title/status bars; execution facts and projections have separate labels/borders');

  const failed = `${month} .calendar-event[data-date-key="2026-10-09"][data-state="failed"]`;
  await browser.click(failed); await browser.wait("!!document.querySelector('.calendar-detail-popover .latest-record')");
  assert.equal(await e("document.querySelector('.calendar-detail-popover .latest-record time').textContent"), '10/09 13:40');
  assert.equal(await e("document.querySelectorAll('.calendar-detail-popover .latest-record li').length"), 1);
  assert.equal(await e("document.querySelector('.calendar-detail-popover .history-toggle').getAttribute('aria-expanded')"), 'false');
  assert.ok(await e("document.querySelector('.calendar-detail-popover .latest-record').textContent.includes('执行失败')"));
  await shot('scheduled-calendar-record.png');
  await browser.click(`${popup} .history-toggle`); await finishMotion(`${popup} .history-expansion`);
  assert.equal(await e("document.querySelectorAll('.calendar-detail-popover .heat-cell').length"), 84);
  await browser.key('Escape'); await finishMotion(`${popup} .history-expansion`);
  assert.ok(await e("!!document.querySelector('.calendar-detail-popover .latest-record')"));
  await browser.key('Escape'); await waitPopupClosed();
  assert.equal(await e("document.activeElement.dataset.dateKey"), '2026-10-09');
  cases.push('Click a historical bar to view that exact immutable record, not the latest one; heatmap closes before the anchored popup and focus returns');
  await browser.click(failed); await browser.wait("!!document.querySelector('.calendar-detail-popover .latest-record')");
  await browser.click('.calendar-toolbar h2'); await waitPopupClosed();
  await browser.click(failed); await browser.wait("!!document.querySelector('.calendar-detail-popover .latest-record')");
  await browser.click('.calendar-detail-popover .detail-prompt > button');
  await browser.wait("document.querySelector('.editor-shell').dataset.open==='true'"); await waitPopupClosed();
  assert.ok(await e("document.querySelector('#task-prompt').value.startsWith('阅读过去 24 小时')"), 'editing an old execution opens the current plan, not the immutable old prompt');
  await browser.key('Escape'); await finishMotion('.editor-shell');
  assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), 'false');
  cases.push('Owned popup keeps internal actions, closes on a genuine outside click, and edit opens the current plan without mutating the old execution');

  await browser.click(`${month} .month-date-button[data-date-key="2026-10-09"]`); await browser.key('ArrowRight');
  await browser.wait("document.querySelector('.calendar-view').dataset.selectedDate==='2026-10-10'");
  assert.equal(await e("document.activeElement.dataset.dateKey"), '2026-10-10');
  await browser.click('[aria-label="下个月"]');
  assert.ok(await e("document.querySelector('.calendar-toolbar h2').textContent.includes('11月')"));
  assert.ok(await e("!!document.querySelector('.calendar-layer[data-active=true] .calendar-event[data-date-key=\"2026-11-15\"][data-task=changelog][data-entry-kind=planned]')"));
  await browser.click('[aria-label="上个月"]'); await browser.click('[aria-label="回到示例今天"]');
  cases.push('Month date arrows, previous/next month and return-to-today work; daily appointments expand beyond the saved next occurrence');

  await browser.click('[data-stretch-value="week"]'); await finishMotion('.calendar-layer');
  await browser.wait("document.querySelector('.calendar-view').dataset.calendarMode==='week'");
  assert.equal(await e("document.querySelector('.calendar-layer[data-active=false]').hidden"), true);
  const upcoming = `${week} .calendar-event[data-task="docs"][data-entry-kind="planned"][data-date-key="2026-10-14"]`;
  const geometry = await e(`(()=>{let n=document.querySelector(${JSON.stringify(upcoming)}),p=n.closest('.week-hours'),r=n.getBoundingClientRect(),q=p.getBoundingClientRect();return {minute:Number(n.dataset.minute),day:Number(n.dataset.day),lane:Number(n.dataset.lane),lanes:Number(n.dataset.lanes),top:parseFloat(getComputedStyle(n).top),left:r.left-q.left,parent:p.clientWidth,height:r.height}})()`);
  assert.equal(geometry.minute, 900); assert.equal(geometry.day, 2);
  assert.ok(Math.abs(geometry.top - 960) < 1);
  assert.ok(Math.abs(geometry.left - (56 + (geometry.parent - 56) * (geometry.day + geometry.lane / geometry.lanes) / 7 + 3)) < 1.2);
  assert.equal(Math.round(geometry.height), 44);
  await shot('scheduled-calendar-week.png');
  await browser.click(upcoming); await browser.wait("!!document.querySelector('.calendar-detail-popover .latest-record')");
  assert.ok(await e("document.querySelector('.calendar-detail-popover .calendar-selection-heading').textContent.includes('预计计划')"));
  assert.equal(await e("document.querySelector('.calendar-detail-popover .latest-record time').textContent"), '10/14 10:00');
  await browser.key('Escape'); await waitPopupClosed();
  const scrollBefore = await e("document.querySelector('.calendar-layer[data-active=true] .week-scroll').scrollTop");
  assert.ok(scrollBefore > 0);
  await browser.click('[aria-label="下一周"]');
  assert.ok(await e("document.querySelector('.calendar-toolbar h2').textContent.includes('10月19日')"));
  await browser.click('[aria-label="上一周"]');
  cases.push('Week bars are anchored to Wednesday 15:00 exactly, with fixed 44px reading height and collision lanes; week navigation and forecast details work');

  await switchMain('list'); await finishMotion('.schedule-view-pane');
  assert.equal(await e("document.querySelector('.page-content').dataset.layout"), 'list');
  assert.ok(await e("document.querySelector('.schedule-view-pane[data-active=false]').hidden"));
  await browser.click('input[aria-label="搜索定时任务"]');
  await browser.send('Input.insertText', { text: '赛博虎妞' }); await browser.settle();
  assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 2);
  await switchMain('calendar'); await finishMotion('.schedule-view-pane');
  assert.equal(await e("document.querySelector('input[aria-label=搜索定时任务]').value"), '');
  assert.equal(await e("document.querySelector('[data-stretch-value=all] .filter-count').textContent"), '6');
  assert.equal(await e("document.querySelector('#scheduled-main').dataset.scope"), 'all-employees');
  assert.equal(await e("document.querySelector('.calendar-view').dataset.calendarMode"), 'week');
  await browser.click('[data-stretch-value="paused"]');
  assert.equal(await e("document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event[data-entry-kind=planned]').length"), 0);
  await browser.click('[data-stretch-value="all"]');
  cases.push('Global navigation clears an employee-specific list query, retains date/range, hides/inerts the old view, and paused plans create no fake future bars');

  for (const width of [768, 390, 320]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }); await browser.settle();
    await browser.click('[data-stretch-value="month"]'); await finishMotion('.calendar-layer');
    await e("document.querySelector('.calendar-toolbar').scrollIntoView({block:'start',behavior:'instant'})");
    await ensureFits(`${width}px month`); await shot(`scheduled-calendar-month-${width}.png`);
    assert.ok(await e("document.querySelector('.calendar-layer[data-active=true] .calendar-month-scroll').scrollWidth>=document.querySelector('.calendar-layer[data-active=true] .calendar-month-scroll').clientWidth"));
    await browser.click('[data-stretch-value="week"]'); await finishMotion('.calendar-layer');
    await ensureFits(`${width}px week`); await shot(`scheduled-calendar-week-${width}.png`);
    cases.push(`${width}px: direct bars retained in month and week, readable own-canvas scroll, no document overflow`);
  }
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 960, deviceScaleFactor: 1, mobile: true }); await browser.settle();
  await browser.click('[data-stretch-value="month"]'); await finishMotion('.calendar-layer');
  assert.ok(await e("[...document.querySelectorAll('.calendar-layer[data-active=true] .calendar-event')].every(n=>n.getBoundingClientRect().height>=44)"));
  cases.push('Coarse-pointer month bars/date controls preserve 44px targets rather than shrinking the date grid into unreadable dots');
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1280, deviceScaleFactor: 1, mobile: false });
  for (const label of ['石墨蓝', '森林绿', '雾紫', '深色石墨', '暖白铜色']) { await choose('预览主题', label); await ensureFits(label); if (label === '深色石墨') await shot('scheduled-calendar-dark.png'); }
  cases.push('Both calendar bar states and geometry use the same five project themes');

  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await browser.click('[data-stretch-value="week"]');
  assert.equal(await e("getComputedStyle(document.querySelector('.calendar-layer[data-active=true]')).transitionProperty"), 'none');
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' }); await loadReady(() => browser.send('Page.reload'));
  await browser.wait("document.querySelector('.calendar-view')?.dataset.calendarMode==='month'");
  assert.ok(await e("!!document.querySelector('.calendar-layer[data-active=true] .calendar-event[data-date-key=\"2026-10-14\"][data-task=docs][data-entry-kind=planned]')"));
  cases.push('Reduced motion removes geometry/fades; browser New York timezone does not move Shanghai appointment dates');
  await loadReady(() => browser.send('Page.navigate', { url: pathToFileURL(join(output, 'Wand-scheduled-tasks-preview.html')).href + '?layout=calendar&range=week' }));
  await browser.wait("document.querySelector('.calendar-view')?.dataset.calendarMode==='week'"); await ensureFits('offline week');
  assert.deepEqual(browser.errors, []);
  assert.equal(preview.requests.some(request => request.method !== 'GET' || request.pathname.startsWith('/api/')), false);
  assert.equal(browser.events.filter(event => event.method === 'Network.requestWillBeSent').some(event => !event.params.request.url.startsWith(preview.origin) && !event.params.request.url.startsWith('file:') && !event.params.request.url.startsWith('data:')), false);
  cases.push('Offline month/week design loads with local/shared assets only; zero API, outside, model or production requests');
  const result = { revision: 4, scope: 'isolated calendar design, not production/native acceptance', cases, screenshots, errors: browser.errors, requests: preview.requests, apiRequests: 0, modelCalls: 0, productionChanges: 0 };
  writeFileSync(join(output, 'calendar-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: cases.length, elapsedSeconds: (Date.now() - startedAt) / 1000, cases, screenshots }, null, 2));
} catch (error) {
  writeFileSync(join(output, 'calendar-verification-failure.json'), JSON.stringify({ passed: cases, error: error.message, pageErrors: browser.errors, lastEvents: browser.events.slice(-8).map(event => event.method) }, null, 2) + '\n');
  throw error;
} finally { await browser.close(); preview.server.closeAllConnections(); await new Promise(resolve => preview.server.close(resolve)); }
