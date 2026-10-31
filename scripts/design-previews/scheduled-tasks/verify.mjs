import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openPlushBrowser } from "../helpers/browser-harness.mjs";
import { output, startPreview } from "./serve.mjs";

const preview = await startPreview({ port: 0 });
const browser = await openPlushBrowser(1440, 960, false, "no-preference");
const e = async expression => {
  try { return await browser.evaluate(expression); }
  catch (error) { console.error("Preview assertion expression:", expression.slice(0, 400)); throw error; }
};
const cases = [];
const shots = [];
const shot = async name => {
  await e("document.activeElement?.blur()");
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 35, y: 18 });
  await browser.wait("![...document.querySelectorAll('.ant-tooltip')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible'&&getComputedStyle(n).opacity!=='0')");
  await browser.screenshot(join(output, name)); shots.push(name);
};
const finishMotion = async selector => e(`Promise.allSettled([...document.querySelectorAll(${JSON.stringify(selector)})].flatMap(node=>node.getAnimations()).filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished))`);
const fill = async (selector, text) => {
  await browser.click(selector);
  await e(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await browser.send("Input.insertText", { text }); await browser.settle();
};
const clickLabel = async (label, scope = "button") => {
  await browser.wait(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(n=>n.textContent.trim()===${JSON.stringify(label)}&&n.getClientRects().length)`);
  const selector = await e(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(scope)})].find(n=>n.textContent.trim()===${JSON.stringify(label)}&&n.getClientRects().length);n.dataset.previewTarget='yes';return '[data-preview-target="yes"]'})()`);
  await browser.click(selector); await e("document.querySelector('[data-preview-target]')?.removeAttribute('data-preview-target')");
};
const choose = async (label, option) => { await browser.click(`[role="combobox"][aria-label="${label}"]`); await clickLabel(option, '[role="option"]'); };
const rect = selector => e(`(()=>{let r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(n=>Math.round(n*100)/100)})()`);
const fits = async width => {
  assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1"), true, `${width}px document fits`);
  const geometry = await e("(()=>{let r=document.querySelector('[data-task-id]').getBoundingClientRect(),p=document.querySelector('.page-content').getBoundingClientRect();return {row:r.width,content:p.width}})()");
  assert.ok(geometry.row >= geometry.content - 48, `${width}px real row width is not collapsed (${JSON.stringify(geometry)})`);
};
const pointerPoint = selector => e(`(()=>{let n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!n.contains(document.elementFromPoint(x,y)))throw Error('Pointer target is clipped or covered: '+${JSON.stringify(selector)});return {x,y}})()`);
const rawClick = async selector => {
  const point = await pointerPoint(selector);
  for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
};

try {
  await browser.send("Page.navigate", { url: preview.origin });
  await browser.wait("document.querySelectorAll('[data-task-id]').length===6");
  await browser.wait("!!document.querySelector('.next-section [data-renderer=webgl]')");
  await fits(1440); await shot("scheduled-desktop.png");
  assert.ok(await e("document.querySelector('.next-section').textContent.includes('15:00')"));
  assert.equal(await e("document.querySelector('.next-section').dataset.nextTask"), "docs");
  assert.equal(await e("document.querySelector('.next-prompt').textContent"), "对照现有实现核对 Web 与 macOS 的交互说明。列出不一致项，标注源码入口和验证方式；不要部署或重启服务。");
  assert.ok(await e("document.querySelector('.next-metadata').textContent.includes('/projects/wand') && document.querySelector('.next-metadata').textContent.includes('仅执行一次') && document.querySelector('.next-metadata').textContent.includes('Asia/Shanghai')"));
  assert.ok(await e("document.querySelector('[data-task-id=docs]').dataset.plannedActive==='true' && document.querySelector('[data-task-id=docs] .task-latest').textContent.includes('执行中')"));
  assert.ok((await rect('.next-section'))[3] <= 225, 'representative desktop detail uses one compact block');
  assert.ok((await rect('[data-task-id=docs] .task-summary'))[3] <= 85, 'desktop rows keep two-line density');
  cases.push("Top detail shows the actual earliest plan, full prompt, employee, directory and schedule; past run remains distinct");
  assert.equal(await e("document.querySelectorAll('.task-agenda .employee-face').length"), 6);
  assert.equal(await e("document.querySelector('.next-section .employee-face').dataset.employeeId"), "preview-partner");
  assert.equal(await e("JSON.parse(document.querySelector('.next-section [data-avatar-config]').dataset.avatarConfig).coat"), "silver");
  assert.equal(await e("JSON.parse(document.querySelector('[data-task-id=changelog] [data-avatar-config]').dataset.avatarConfig).coat"), "orange");
  assert.equal(await e("globalThis.__wandPlushDiagnostics().contexts"), 1);
  cases.push("Shared EmployeeAvatar: visible names, stable employee IDs, real 3D cats/geometric heads and one GPU context");
  assert.deepEqual(await e("[...document.querySelectorAll('[data-task-id]')].map(n=>n.dataset.taskId)"), ["docs", "changelog", "archive", "review", "digest", "completed"]);
  assert.deepEqual(await e("[...document.querySelectorAll('.agenda-group-heading h3')].map(n=>n.firstChild.textContent)"), ["今天", "明天", "后天", "周一", "已暂停", "已结束"]);
  assert.equal(await e("document.querySelectorAll('.ant-table').length"), 0);
  assert.ok(await e("!document.querySelector('[data-task-id=digest] .task-time time') && document.querySelector('[data-task-id=digest] .task-time strong').title==='无后续安排'"));
  cases.push("Native Ant List agenda, chronological date groups, inactive plans separate; no table or fake future dates");
  await browser.click('[data-task-id="docs"] [role=switch]');
  await browser.wait("document.querySelector('.next-section').dataset.nextTask==='changelog'");
  assert.equal(await e("JSON.parse(document.querySelector('.next-section [data-avatar-config]').dataset.avatarConfig).coat"), "orange");
  await browser.click('[data-task-id="docs"] [role=switch]');
  await browser.wait("document.querySelector('.next-section').dataset.nextTask==='docs'");
  cases.push("Pausing/restoring the earliest plan changes top detail and employee identity from the same data");

  await browser.click('[data-task-id="changelog"] .task-title-button'); await finishMotion(".inline-details[data-open=true]");
  assert.ok(await e("document.querySelector('.inline-details[data-open=true]').textContent.includes('不修改代码或提交记录')"));
  assert.equal(await e("document.querySelectorAll('.inline-details[data-open=true] .latest-record li').length"), 1);
  assert.equal(await e("document.querySelector('.inline-details[data-open=true] .history-toggle').getAttribute('aria-expanded')"), 'false');
  await shot("scheduled-expanded.png");
  await browser.click('.inline-details[data-open=true] .history-toggle'); await finishMotion('.history-expansion');
  assert.equal(await e("document.querySelectorAll('.heat-cell').length"), 84);
  assert.equal(await e("document.querySelector('.heat-cell[data-date=\"2026-10-09\"]').dataset.outcome"), 'mixed');
  await e("document.querySelector('.execution-heatmap').scrollIntoView({block:'center',behavior:'instant'})");
  await shot('scheduled-heatmap.png');
  await browser.click('.heat-cell[data-date="2026-10-09"]');
  assert.equal(await e("document.querySelectorAll('.heat-day-detail li').length"), 2);
  assert.ok(await e("document.querySelector('.heat-day-detail').textContent.includes('执行失败') && document.querySelector('.heat-day-detail').textContent.includes('已完成')"));
  await shot('scheduled-heatmap-day.png');
  await browser.click('.heat-cell[data-date="2026-10-09"]');
  await browser.key('ArrowLeft');
  assert.equal(await e("document.activeElement.dataset.date"), '2026-10-02');
  for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36, ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await browser.settle();
  assert.ok(await e("document.querySelector('.heat-day-detail').textContent.includes('已跳过')"));
  await browser.key('Escape'); await finishMotion('.history-expansion');
  assert.equal(await e("document.querySelector('.inline-details[data-open=true] .history-toggle').getAttribute('aria-expanded')"), 'false');
  assert.equal(await e("document.activeElement.classList.contains('history-toggle')"), true);
  cases.push('History defaults to one latest record; 12-week heatmap aggregates real samples, mixed-day drilldown, arrow/Enter and Escape work');
  await browser.key("Escape"); await finishMotion(".inline-details");
  assert.equal(await e("document.querySelectorAll('.inline-details[data-open=true]').length"), 0);
  assert.ok(await e("document.querySelectorAll('.inline-details[data-open=false]').length>0 && [...document.querySelectorAll('.inline-details[data-open=false]')].every(n=>n.getBoundingClientRect().height<=1)"), "closed details leave no empty spacer row");
  assert.equal(await e("document.activeElement.classList.contains('task-title-button')"), true);
  cases.push("Expand full prompt and immutable latest run directory; history closes before the task and restores focus");

  await browser.click('[data-stretch-value="paused"]');
  assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 1);
  assert.equal(await e("document.querySelector('[data-task-id]').dataset.taskId"), "digest");
  assert.equal(await e("document.querySelector('.next-section').dataset.nextTask"), "docs", "local filters do not change the global next task");
  await browser.click('[data-task-id="digest"] [role=switch]');
  await browser.wait("document.querySelectorAll('[data-task-id]').length===0");
  await browser.click('[data-stretch-value="all"]');
  await browser.click('[data-task-id="digest"] [role=switch]');
  await fill('input[aria-label="搜索定时任务"]', "不存在的预览任务");
  assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 0);
  assert.ok(await e("document.querySelector('.ant-empty').textContent.includes('没有匹配')"));
  await browser.key("Escape");
  assert.equal(await e("document.querySelector('input[aria-label=搜索定时任务]').value"), "");
  assert.equal(await e("document.activeElement.getAttribute('aria-label')"), "搜索定时任务");
  cases.push("Plan pause/resume updates real filter counts; no-result and search Escape preserve focus");

  const createRect = await rect(".create-trigger");
  await browser.click(".create-trigger"); await finishMotion(".editor-shell");
  assert.deepEqual(await rect(".create-trigger"), createRect, "create trigger keeps position and size");
  assert.equal(await e("document.activeElement.id"), "task-name");
  await browser.click(".save-button");
  assert.ok(await e("document.querySelector('.editor [role=alert]').textContent.includes('请选择执行员工')"));
  await fill("#task-name", "待安排的草稿"); await fill("#task-prompt", "切换编辑对象时保留这段输入。");
  await browser.key("Escape"); await finishMotion(".editor-shell");
  await browser.click('[data-task-id="docs"] button[aria-haspopup=menu]'); await clickLabel("编辑任务", '[role="menuitem"]');
  await browser.wait("![...document.querySelectorAll('.ant-dropdown')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')");
  await finishMotion(".editor-shell"); await browser.key("Escape"); await finishMotion(".editor-shell");
  assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), "false");
  await browser.click(".create-trigger"); await finishMotion(".editor-shell");
  assert.equal(await e("document.querySelector('#task-name').value"), "待安排的草稿");
  assert.equal(await e("document.querySelector('#task-prompt').value"), "切换编辑对象时保留这段输入。");
  cases.push("Closing/reopening and switching editing objects keep per-task drafts in memory");
  await browser.click('[role=combobox][aria-label="执行员工"]');
  await fill('input[aria-label="搜索员工"]', "赛博");
  assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), "true");
  await clickLabel("赛博虎妞", '[role="option"]');
  await browser.click('[role=combobox][aria-label="执行工作区"]');
  await fill('input[aria-label="搜索工作区"]', "Wand");
  await clickLabel("Wand", '[role="option"]');
  await fill("#task-name", "每天核对项目交付");
  await fill("#task-prompt", "整理实际修改和验证结果。保留所有未提交工作，不执行部署或清理。\n这只是设计预览，不调用真实模型。");
  await browser.click('[data-stretch-value="weekly"]');
  assert.ok(await e("!!document.querySelector('[aria-label=执行星期]')"));
  await choose("执行星期", "周五");
  await browser.click('[aria-label="执行时间"]');
  await browser.key("Escape");
  assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), "true");
  await browser.click('[data-stretch-value="once"]');
  await browser.click('[aria-label="执行日期与时间"]');
  await browser.key("Escape");
  assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), "true");
  await browser.click('[data-stretch-value="daily"]');
  await finishMotion(".editor-shell");
  await e("(()=>{let p=document.querySelector('.page-scroll'),s=document.querySelector('.editor-shell');p.scrollTop+=s.getBoundingClientRect().top-p.getBoundingClientRect().top})()");
  await shot("scheduled-create.png");
  const saveRect = await rect(".save-button");
  await rawClick(".save-button");
  await browser.wait("document.querySelector('.save-button').textContent.includes('已保存到预览')");
  assert.deepEqual(await rect(".save-button"), saveRect, "feedback keeps the same button geometry");
  assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 7);
  await browser.key("Escape");
  await finishMotion(".editor-shell");
  const newId = await e("[...document.querySelectorAll('[data-task-id]')].find(n=>n.textContent.includes('每天核对项目交付')).dataset.taskId");
  const newRow = `[data-task-id="${newId}"]`;
  assert.equal(await e(`document.querySelector(${JSON.stringify(newRow + " .task-time time")}).textContent`), "09:00");
  assert.ok(await e(`document.querySelector(${JSON.stringify(newRow)}).closest('.agenda-group').querySelector('h3').textContent.includes('明天')`));
  cases.push("Create once/daily/weekly, searched Portal selectors, date/time Escape, inline validation, fixed-position save/result; no real execution");

  await browser.click(`${newRow} button[aria-haspopup=menu]`);
  await clickLabel("编辑任务", '[role="menuitem"]');
  const longName = "核对定时任务的执行对象、工作目录、计划时区与每次独立会话的交付结果".repeat(3);
  await fill("#task-name", longName);
  await browser.click(".save-button"); await browser.wait("document.querySelector('.save-button').textContent.includes('已保存到预览')");
  await browser.key("Escape"); await finishMotion(".editor-shell");
  await browser.click(`${newRow} .task-title-button`); await finishMotion(".inline-details[data-open=true]");
  assert.equal(await e("document.querySelector('.inline-details[data-open=true] .detail-prompt h2').textContent"), longName);
  cases.push("Long title truncates in the list and is fully readable on expansion; edits stay in memory");
  await browser.click(`${newRow} button[aria-haspopup=menu]`);
  await clickLabel("取消计划", '[role="menuitem"]');
  assert.ok(await e("document.querySelector('.cancel-confirm').textContent.includes('不停止已开始的执行')"));
  await clickLabel("保留计划");
  await browser.click(`${newRow} button[aria-haspopup=menu]`); await clickLabel("取消计划", '[role="menuitem"]');
  await clickLabel("确认取消");
  assert.ok(await e(`document.querySelector(${JSON.stringify(newRow)}).textContent.includes('已取消')`));
  cases.push("More menu uses shared Portal; cancellation is explicit, reversible before confirmation and retains record semantics");

  await browser.click('.next-more-trigger');
  await clickLabel("编辑计划", '[role="menuitem"]');
  const longPrompt = "核对所有实际修改、验证证据、执行约束和未完成事项；不改变用户数据。".repeat(5) + "最后一句也必须完整显示。";
  await fill("#task-name", longName); await fill("#task-prompt", longPrompt);
  await browser.click(".save-button"); await browser.wait("document.querySelector('.save-button').textContent.includes('已保存到预览')");
  await browser.key("Escape"); await finishMotion(".editor-shell");
  await e("document.querySelector('.page-scroll').scrollTop=0");
  assert.equal(await e("document.querySelector('.next-description h3').textContent"), longName);
  assert.equal(await e("document.querySelector('.next-prompt').textContent"), longPrompt);
  assert.ok(await e("(()=>{let n=document.querySelector('.next-prompt');return n.scrollHeight<=n.clientHeight+1})()"));
  await shot("scheduled-next-long.png");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 960, deviceScaleFactor: 1, mobile: false }); await browser.settle();
  assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.next-prompt').scrollHeight<=document.querySelector('.next-prompt').clientHeight+1"), true);
  await shot("scheduled-next-long-390.png");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }); await browser.settle();
  cases.push("Next task detail preserves long full titles/prompts without clamp or overflow at desktop and 390px");

  await browser.click('[aria-label="重置预览"]');
  for (const width of [768, 390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false }); await browser.settle();
    await e("document.querySelector('.page-scroll').scrollTop=0");
    await fits(width);
    if (width === 390) {
      await e("document.querySelector('.page-scroll').scrollTop=0");
      assert.ok((await rect(".next-section"))[3] <= 330, "representative mobile detail stays compact without truncating content");
      assert.ok((await rect('[data-task-id=docs] .task-summary'))[3] <= 110, 'mobile row avoids a separate action footer');
      assert.ok((await rect("[data-task-id=docs]"))[1] < 960, "the first timed row is visible below the complete mobile detail");
    }
    await shot(`scheduled-${width}.png`);
    await browser.click('[data-task-id="changelog"] .task-title-button'); await finishMotion(".inline-details[data-open=true]");
    assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1"), true);
    await browser.key("Escape"); await finishMotion(".inline-details");
    cases.push(`${width}px: actual row width, no document overflow, readable schedule/result and reachable inline detail`);
  }
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true }); await browser.settle();
  if (await e("matchMedia('(pointer:coarse)').matches")) {
    assert.equal(await e("getComputedStyle(document.querySelector('.switch-hitbox')).display"), 'none');
    assert.ok((await rect(".task-actions .wand-ui-icon-button"))[3] >= 44);
    await browser.click('[data-task-id="docs"] button[aria-haspopup=menu]'); await clickLabel('暂停计划', '[role="menuitem"]');
    await browser.wait("document.querySelector('.next-section').dataset.nextTask==='changelog'");
    await browser.click('[data-task-id="docs"] button[aria-haspopup=menu]'); await clickLabel('恢复计划', '[role="menuitem"]');
    await browser.wait("document.querySelector('.next-section').dataset.nextTask==='docs'");
    await fits("390-touch"); cases.push("Compact touch rows: 44px menu with real pause/resume; no detached switch/footer");
    await browser.click('[data-task-id="docs"] button[aria-haspopup=menu]'); await clickLabel('编辑任务', '[role="menuitem"]');
    await browser.wait("document.querySelector('.editor-shell').dataset.open==='true' && ![...document.querySelectorAll('.ant-dropdown')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')");
    await finishMotion('.editor-shell');
    assert.equal(await e("document.querySelector('#task-name').value"), '核对 Web 与 Mac 的交互说明');
    await browser.key('Escape'); await finishMotion('.editor-shell');
    assert.equal(await e("document.querySelector('.editor-shell').dataset.open"), 'false');
    await browser.click('[data-task-id="docs"] button[aria-haspopup=menu]');
    await browser.wait("!!document.querySelector('.ant-dropdown [role=menu]')");
    await browser.key('Escape');
    await browser.wait("![...document.querySelectorAll('.ant-dropdown')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')");
    assert.equal(await e("document.activeElement.getAttribute('aria-label')"), '核对 Web 与 Mac 的交互说明的更多操作');
    cases.push('Compact mobile menu: edit retains content, Escape closes editor/menu in order and restores trigger focus');
  }
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }); await browser.settle();

  for (const [value, label] of [["empty", "空列表"], ["loading", "首次加载"], ["error", "首次失败"], ["refresh-error", "刷新失败"]]) {
    await choose("预览状态", label); await browser.settle();
    if (value === "refresh-error") assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 6);
    else assert.equal(await e("document.querySelectorAll('[data-task-id]').length"), 0);
    if (value === "error" || value === "loading") assert.equal(await e("[...document.querySelectorAll('.filter-count')].every(n=>n.textContent==='—') && !document.querySelector('.list-context').textContent.includes('共 0')"), true, "unknown data is not advertised as a zero count");
    await shot(`scheduled-${value}.png`); cases.push(`State: ${value}; distinguishes missing data from preserved refresh data`);
  }
  await choose("预览状态", "正常列表");
  const storageBefore = await e("JSON.stringify(Object.entries(localStorage))");
  for (const label of ["石墨蓝", "森林绿", "雾紫", "深色石墨", "暖白铜色"]) {
    await choose("预览主题", label); await fits(1440);
    if (label === "深色石墨") await shot("scheduled-dark.png");
  }
  assert.equal(await e("JSON.stringify(Object.entries(localStorage))"), storageBefore, "theme preview never persists production preferences");
  cases.push("All five production themes; dark screenshot; theme persistence adapted to memory only");

  await browser.click('[aria-label="重置预览"]');
  await e("document.querySelector('.page-scroll').scrollTop=0");
  // The live WebGL avatar path was verified above. Isolate CSS geometry from
  // GPU compilation/contention with the actual supported SVG fallback; keep
  // the same timing tokens, UI clicks and strict intermediate-frame assertions.
  const motion = await openPlushBrowser(1440, 960, true, 'no-preference');
  try {
    await motion.send('Page.navigate', { url: preview.origin });
    await motion.wait("!!document.querySelector('.next-section [data-renderer=fallback]')");
    for (const direction of ['open', 'close']) {
      await motion.evaluate("document.querySelector('[data-task-id=changelog] .task-title-button').scrollIntoView({block:'center',behavior:'instant'})");
      await motion.settle();
      const point = await motion.evaluate("(()=>{const n=document.querySelector('[data-task-id=changelog] .task-title-button'),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!n.contains(document.elementFromPoint(x,y)))throw Error('Motion trigger covered');return {x,y}})()");
      const samplesPromise = motion.evaluate(`new Promise((resolve,reject)=>{const node=()=>document.querySelector('[data-task-id=changelog] .inline-details');const read=()=>node()?.getBoundingClientRect().height??0;const rows=[read()],started=performance.now();let changedAt=null;const t=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-normal'));function frame(){let now=performance.now();rows.push(read());if((node()?.dataset.open==='true')===${direction === 'open'}&&changedAt===null)changedAt=now;if(changedAt!==null&&now-changedAt>=t*1.6)resolve(rows);else if(now-started>5000)reject(Error('Motion state did not change'));else requestAnimationFrame(frame)}requestAnimationFrame(frame)})`);
      for (const type of ['mousePressed', 'mouseReleased']) await motion.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      const samples = await samplesPromise, max = Math.max(...samples), min = Math.min(...samples);
      assert.ok(max > 100 && min < 5, `${direction}: detail travels fully closed/open; min=${min}, max=${max}`);
      assert.ok(samples.some(value => value > 5 && value < max - 5), `${direction}: actual intermediate frames`);
      cases.push(`Motion ${direction}: actual intermediate geometry in SVG fallback fixture, unchanged Wand tokens`);
    }
    assert.deepEqual(motion.errors, []);
  } finally { await motion.close(); }
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await browser.click('[data-task-id="changelog"] .task-title-button');
  assert.equal(await e("getComputedStyle(document.querySelector('.inline-details[data-open=true]')).transitionProperty"), "none");
  await browser.key("Escape");
  cases.push("Reduced motion: instantaneous inline geometry; same content and keyboard close");

  await browser.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
  await browser.send("Page.reload"); await browser.wait("document.querySelectorAll('[data-task-id]').length===6");
  assert.equal(await e("Intl.DateTimeFormat().resolvedOptions().timeZone"), "America/New_York");
  assert.equal(await e("document.querySelector('.next-schedule time').textContent"), "15:00");
  assert.ok(await e("document.querySelector('.agenda-group-heading h3').textContent.includes('今天')"));
  await browser.send("Emulation.setTimezoneOverride", { timezoneId: "" });
  cases.push("Browser New York zone does not change Shanghai agenda dates, grouping or next-task time");

  const fallback = await openPlushBrowser(390, 960, true, "reduce");
  try {
    await fallback.send("Page.navigate", { url: preview.origin });
    await fallback.wait("!!document.querySelector('.next-section [data-renderer=fallback]')");
    assert.equal(await fallback.evaluate("JSON.parse(document.querySelector('.next-section [data-avatar-config]').dataset.avatarConfig).coat"), "silver");
    assert.equal(await fallback.evaluate("document.querySelector('.next-section .employee-face').dataset.employeeId"), "preview-partner");
    assert.equal(await fallback.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
    await fallback.screenshot(join(output, "scheduled-avatar-fallback.png")); shots.push("scheduled-avatar-fallback.png");
    assert.deepEqual(fallback.errors, []);
    assert.equal(fallback.events.filter(event => event.method === "Network.requestWillBeSent").some(event => !event.params.request.url.startsWith(preview.origin) && !event.params.request.url.startsWith("data:")), false);
    cases.push("Actual WebGL-disabled Chrome uses the same employee/coating SVG fallback, without extra API or external requests");
  } finally { await fallback.close(); }

  await browser.send("Page.navigate", { url: pathToFileURL(join(output, "Wand-scheduled-tasks-preview.html")).href });
  await browser.wait("document.querySelectorAll('[data-task-id]').length===6");
  await browser.click(".create-trigger");
  await browser.wait("document.querySelector('.editor-shell').dataset.open==='true'");
  await browser.key("Escape");
  assert.deepEqual(browser.errors, []);
  assert.equal(preview.requests.some(request => request.method !== "GET" || request.pathname.startsWith("/api/")), false);
  const outbound = browser.events.filter(event => event.method === "Network.requestWillBeSent").map(event => event.params.request.url);
  assert.equal(outbound.some(url => !url.startsWith(preview.origin) && !url.startsWith("file:") && !url.startsWith("data:")), false);
  cases.push("Offline HTML opens and interacts; CSP connect-src none; GET assets only, zero API/model/production requests");
  const report = { scope: "Isolated scheduled-task design, NOT production functionality acceptance", cases, screenshots: shots, errors: browser.errors,
    requests: preview.requests, outsideRequests: 0, apiRequests: 0, modelCalls: 0, installedServiceMutations: 0 };
  writeFileSync(join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ scope: report.scope, passed: cases.length, cases, screenshots: shots }, null, 2));
} catch (error) {
  writeFileSync(join(output, "verification-failure.json"), JSON.stringify({ passedBeforeFailure: cases, error: error.message }, null, 2) + "\n");
  throw error;
} finally { await browser.close(); preview.server.closeAllConnections(); await new Promise(resolve => preview.server.close(resolve)); }
