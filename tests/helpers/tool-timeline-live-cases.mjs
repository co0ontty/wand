import assert from "node:assert/strict";

/** Real pointer/keyboard scrolling and the production renderer; no model calls. */
export async function runLiveTimelineCases({ e, send, click, wait, mode, report }) {
  const requestsBefore = report.requests.length;
  await e(`(async () => {
    window.liveCall = i => ({ type:"tool_use", id:"live-call-"+i, name:"Bash", input:{},
      preview:"npm run check · "+i, activity:{kind:"run_command",label:"运行命令 · Bash"} });
    window.liveTurns = [{role:"assistant",uuid:${JSON.stringify("live-" + mode)},content:Array.from({length:24},(_,i)=>liveCall(i))}];
    await h.fresh(liveTurns,true);
    window.liveGroup=document.querySelector('.chat-activity');
    window.liveTimeline=liveGroup.querySelector('.chat-activity-timeline');
    window.liveSummary=liveGroup.querySelector('button.chat-process-summary');
    window.liveArrow=liveSummary.querySelector('svg');
    liveSummary.scrollIntoView({block:'nearest'});
  })()`);
  await e("h.settle()");
  const initial = await e(`(() => ({open:liveGroup.dataset.expanded, top:liveTimeline.scrollTop,
    gap:liveTimeline.scrollHeight-liveTimeline.clientHeight-liveTimeline.scrollTop,
    height:liveTimeline.clientHeight, viewport:document.querySelector('.chat-messages').clientHeight,
    below:liveTimeline.getBoundingClientRect().top>=liveSummary.getBoundingClientRect().bottom-1,
    details:liveTimeline.querySelectorAll('.chat-call[data-expanded="true"]').length,
    wide:document.documentElement.scrollWidth>innerWidth+1}))()`);
  assert.equal(initial.open, "true", "latest running group opens without a click in " + mode);
  assert.equal(initial.below, true, "timeline grows below its summary");
  assert.equal(initial.height, Math.round(Math.max(120, Math.min(240, initial.viewport / 3))));
  assert.ok(initial.top > 0 && initial.gap <= 2, "first view shows the newest row");
  assert.equal(initial.details, 0, "auto-open only reveals lightweight rows, not full bodies");
  assert.equal(initial.wide, false);
  await e(`(async()=>{liveTurns[0].content.push(liveCall(24));h.publish(liveTurns,true);await h.settle()})()`);
  assert.ok(await e("liveTimeline.scrollHeight-liveTimeline.clientHeight-liveTimeline.scrollTop<=2"), "new calls follow the tail");
  assert.equal(await e("liveSummary===liveGroup.querySelector('button.chat-process-summary')&&liveSummary.contains(liveArrow)"), true);
  assert.equal(report.requests.length, requestsBefore, "no prefetch on auto-open or new output");

  // Real wheel input pauses following and makes the open state a user choice.
  const point = await e("(()=>{const r=liveTimeline.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  const oldTop = await e("liveTimeline.scrollTop");
  // One synthetic wheel can land while the drawer is still settling its geometry; a
  // real user keeps scrolling. Genuine input events stay the only pause trigger.
  let scrolled = false;
  for (let attempt = 0; attempt < 3 && !scrolled; attempt++) {
    await send("Input.dispatchMouseEvent", { type:"mouseWheel", ...point, deltaX:0, deltaY:-120 });
    await e("new Promise(r=>setTimeout(r,150))");
    scrolled = await e(`liveTimeline.scrollTop<${oldTop - 10}`);
  }
  assert.ok(scrolled, "a real wheel moves the drawer off the tail");
  await e("h.settle()");
  const readingTop = await e("liveTimeline.scrollTop");
  const outerTop = await e("document.querySelector('.chat-messages').scrollTop");
  await e(`(async()=>{liveTurns[0].content.push(liveCall(25));h.publish(liveTurns,true);await h.settle()})()`);
  assert.ok(Math.abs(await e("liveTimeline.scrollTop") - readingTop) <= 1, "new output cannot interrupt reading older rows");
  assert.ok(Math.abs(await e("document.querySelector('.chat-messages').scrollTop") - outerTop) <= 1, "inner following never moves outer chat");
  await e("(async()=>{h.publish(liveTurns,false);await h.settle()})()");
  assert.equal(await e("liveGroup.dataset.expanded"), "true", "completion preserves a manually inspected timeline");
  await click("button.chat-process-summary"); await e("h.settle()");
  await e("(async()=>{liveTurns[0].content.push(liveCall(26));h.publish(liveTurns,true);await h.settle()})()");
  assert.equal(await e("liveGroup.dataset.expanded"), "false", "manual collapse survives new output");
  await click("button.chat-process-summary"); await e("h.settle()");
  assert.ok(await e("liveTimeline.scrollHeight-liveTimeline.clientHeight-liveTimeline.scrollTop<=2"), "reopening the live drawer starts from latest");

  // Inspecting a detail pauses the drawer; closing it must not stay paused forever.
  await e(`(()=>{const last=[...liveTimeline.querySelectorAll(".chat-call-button")].pop();last.id="probe-row"})()`);
  await click("#probe-row");
  await wait('document.querySelector(\'.chat-call[data-expanded="true"]\')');
  await e("h.settle()");
  const inspectingTop = await e("liveTimeline.scrollTop");
  await e(`(async()=>{liveTurns[0].content.push(liveCall(27));h.publish(liveTurns,true);await h.settle()})()`);
  assert.ok(Math.abs(await e("liveTimeline.scrollTop") - inspectingTop) <= 1, "an open detail freezes the drawer");
  await click("#probe-row"); await e("h.settle()");
  await e(`(async()=>{liveTurns[0].content.push(liveCall(28));h.publish(liveTurns,true);await h.settle()})()`);
  assert.ok(await e("liveTimeline.scrollHeight-liveTimeline.clientHeight-liveTimeline.scrollTop<=2"), "closing a detail resumes tail following");

  // Row reflow is layout noise, not reading intent: the live drawer stays at the tail.
  await e(`(async()=>{liveTurns[0].content=liveTurns[0].content.map((b,i)=>({...b,
    preview:"npm run check · " + i + " · " + "一段会改变行高的很长很长的命令输出摘要".repeat(2)}));
  h.publish(liveTurns,true);await h.settle()})()`);
  assert.ok(await e("liveTimeline.scrollHeight-liveTimeline.clientHeight-liveTimeline.scrollTop<=2"), "row reflow keeps the live drawer at the tail");

  // Inspecting a detail also freezes the drawer, even without scrolling first.
  await e(`(async()=>{await h.fresh([{role:'assistant',uuid:${JSON.stringify("inspect-" + mode)},content:[liveCall(30)]}],true)})()`);
  await click("button.chat-call-button");
  await wait('document.querySelector(".chat-call-detail")?.textContent.includes("DETAIL_ONLY")');
  await e("h.settle()");
  await e("(async()=>{h.publish(h.turns(),false);await h.settle()})()");
  assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"), "true");
  assert.equal(await e("document.querySelector('.chat-call').dataset.expanded"), "true", "completion cannot hide the detail being read");

  // Automatic defaults are not persisted. A finished untouched group closes;
  // historical groups remain closed and a new running group opens independently.
  await e(`(async()=>{await h.fresh([{role:'assistant',uuid:${JSON.stringify("finish-" + mode)},content:[liveCall(40)]}],true)})()`);
  const shortHeight = await e("document.querySelector('.chat-activity-timeline').clientHeight");
  assert.ok(shortHeight > 0 && shortHeight < initial.height, "one row does not reserve a blank fixed-height window");
  await e("(async()=>{h.publish(h.turns(),false);await h.settle()})()");
  assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"), "false");
  assert.equal(await e("document.querySelector('.chat-activity-menu').inert"), true);
  await e(`(async()=>{h.publish([...h.turns(),{role:'user',uuid:'next-input',content:[{type:'text',text:'继续'}]},
    {role:'assistant',uuid:${JSON.stringify("next-" + mode)},content:[liveCall(41)]}],true);await h.settle()})()`);
  assert.deepEqual(await e("[...document.querySelectorAll('.chat-activity')].map(n=>({live:n.dataset.live,open:n.dataset.expanded})).sort((a,b)=>a.live.localeCompare(b.live))"),
    [{live:"false",open:"false"},{live:"true",open:"true"}]);
  report.cases.push({ mode, case:"live-auto-expand", ok:true, viewportHeight:initial.viewport,
    panelHeight:initial.height, defaultTail:true, respectsReading:true, manualOverride:true, noPrefetch:true, completionCollapse:true });
}
