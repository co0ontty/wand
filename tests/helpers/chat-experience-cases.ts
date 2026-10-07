import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Real renderer/controls with nonsecret synthetic turns, not installed acceptance. */
export async function runChatExperience({ evaluate: e, send, click, key, wait, mode, result, responsePlans, output }) {
  await e(`(async()=>{
    window.h=focusRefreshHarness;
    await h.fresh([]);
    window.emptyChatRoot=document.querySelector(".chat-messages");
    document.getElementById("input-box").value="空会话也保留草稿";
    h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e('document.querySelector(".chat-messages").innerText.trim()'), "", "empty is not a fabricated opening message");
  assert.equal(await e('document.querySelector(".chat-messages")===emptyChatRoot'),true);
  assert.equal(await e('document.getElementById("input-box").value'),"空会话也保留草稿");
  await e(String.raw`(async()=>{
    window.h=focusRefreshHarness;
    document.getElementById('chat-output').style.height='calc(100dvh - 76px)';
    window.experienceTurns=[
      {role:'user',uuid:'request',createdAt:'2026-10-07T12:26:00Z',content:[{type:'text',text:'请仔细整理会话的显示层级，让回复好读、进度清楚、细节按需展开。'}]},
      {role:'assistant',uuid:'reply-intro',content:[{type:'text',text:'我会先核对实际页面，再整理正文、执行过程和工具详情的层级。'}]},
      {role:'assistant',uuid:'process',content:[
        {type:'thinking',thinking:'第一轮：核对界面结构与已有约定。',occurredAt:'2026-10-07T12:26:10Z'},
        {type:'tool_use',id:'plan-create',name:'Pi/todo',input:{action:'create',subject:'核对截图和现有体验',description:'这是一段不应该被拿来当成大卡片标题的内部任务说明。'.repeat(8)}},
        {type:'tool_result',tool_use_id:'plan-create',content:'Created #1: 核对截图和现有体验 (pending)'},
        {type:'tool_use',id:'plan-update',name:'Pi/todo',input:{action:'update',id:1,status:'completed'}},
        {type:'tool_result',tool_use_id:'plan-update',content:'Updated #1 (pending → completed)'},
        {type:'thinking',thinking:'第二轮：将任务流水与真正的回复分开显示。',occurredAt:'2026-10-07T12:26:20Z'},
        {type:'tool_use',id:'plan-next',name:'Pi/todo',input:{action:'create',subject:'优化会话阅读体验'},semantic:{kind:'task_list',items:[{content:'核对截图和现有体验',status:'completed'},{content:'优化会话阅读体验',status:'pending'}]}},
        {type:'tool_result',tool_use_id:'plan-next',content:'Created #2: 优化会话阅读体验 (pending)'},
        {type:'tool_use',id:'read-ui',name:'Read',input:{},preview:'src/web-ui/react/chat/presentation.tsx',activity:{kind:'read_file',fileKey:'ui',label:'查看 chat/presentation.tsx',occurredAt:'2026-10-07T12:26:25Z'}},
        {type:'tool_result',tool_use_id:'read-ui',content:'',preview:'已读取 240 行'},
        {type:'tool_use',id:'test-ui',name:'Bash',input:{},preview:'npm test -- chat',activity:{kind:'run_command',label:'运行界面回归',occurredAt:'2026-10-07T12:26:28Z'}},
        {type:'tool_result',tool_use_id:'test-ui',content:'failed',preview:'一个窄屏断言失败，正在修正',is_error:true}
      ]},
      {role:'assistant',uuid:'reply-result',createdAt:'2026-10-07T12:27:00Z',content:[{type:'text',text:'### 已定位问题\n待办回执不应该挤占正文；工具参数和完整输出应放在执行详情里。\n\n- 正文：优先展示沟通和结果。\n- 过程：用紧凑摘要保留真实进度。\n- 详情：点击对应记录再查看原始内容。'}]}
    ];
    await h.fresh(experienceTurns);
  })()`);
  const summary = "button.chat-process-summary";
  const stats = await e(`(()=>{const summary=document.querySelector('button.chat-process-summary'),group=summary.closest('.chat-message');return {
    planCards:document.querySelectorAll('.chat-tool-card[data-tool-use-id^="plan-"]').length,
    planRecords:document.querySelectorAll('.chat-call[data-tool-ids*=plan-]').length,
    outerReply:group.querySelectorAll('.assistant-reply-host').length,
    summary:summary.innerText,summaryHeight:summary.getBoundingClientRect().height,
    overflow:document.documentElement.scrollWidth>innerWidth+1,
    hiddenDetail:group.querySelector('.chat-disclosure-body').getBoundingClientRect().height,
    taskItems:h.state.currentMessages[2].content.find(b=>b.semantic?.kind==='task_list').semantic.items.length
  }})()`);
  assert.equal(stats.planCards, 0);
  assert.equal(stats.planRecords, 3);
  assert.equal(stats.outerReply, 0);
  assert.equal(stats.taskItems, 2, "the progress owner remains intact");
  assert.match(stats.summary, /待办更新 3 次/);
  assert.match(stats.summary, /1 项失败/, "failure cannot disappear into collapsed history");
  assert.doesNotMatch(stats.summary, /Created|Updated|内部任务说明/);
  assert.ok(stats.summaryHeight <= 90);
  assert.equal(stats.hiddenDetail, 0);
  assert.equal(stats.overflow, false);
  if (output) {
    const shot=await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(join(dirname(output),`experience-${mode}-collapsed.png`),Buffer.from(shot.data,"base64"));
  }
  await click(summary); await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"),"true");
  const rows = await e(`(()=>({thinking:[...document.querySelectorAll('.chat-call[data-thinking-entry]')].map(n=>({height:n.querySelector('button').getBoundingClientRect().height,state:n.dataset.status,text:n.querySelector('button').innerText})),tools:[...document.querySelectorAll('.chat-call[data-tool-ids] button')].map(n=>n.getBoundingClientRect().height),height:document.querySelector('.chat-activity-timeline').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth+1}))()`);
  assert.equal(rows.thinking.length, 2);
  assert.ok(rows.thinking.every(row=>row.height<=44&&row.state==="complete"));
  assert.ok(rows.tools.every(height=>height<=64), "tool rows are two lines, not cards");
  assert.ok(rows.height<=360);
  assert.equal(rows.overflow,false);
  if (output) {
    const shot=await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(join(dirname(output),`experience-${mode}-expanded.png`),Buffer.from(shot.data,"base64"));
  }
  const plan = '.chat-call[data-tool-ids*=plan-create] button';
  responsePlans.push({input:{action:"create",subject:"核对截图和现有体验",description:"完整任务说明按需可达"},content:"Created #1: 核对截图和现有体验 (pending)",pending:false,resultAvailable:true});
  const beforeRequests=result.requests.length;
  await click(plan);
  await wait("document.querySelector('.chat-call[data-tool-ids*=\"plan-create\"] .chat-call-detail').textContent.includes('完整任务说明按需可达')","plan details");
  assert.equal(result.requests.length,beforeRequests+1);
  await key("Escape"); await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-call[data-tool-ids*=\"plan-create\"]').dataset.expanded"),"false");
  assert.equal(await e("document.querySelector('.chat-call[data-tool-ids*=\"plan-create\"] .chat-disclosure-body').getBoundingClientRect().height"),0,"Escape visually closes, not just its ARIA attribute");
  await key("Escape"); await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-activity > div .chat-disclosure-body').getBoundingClientRect().height"),0,"second Escape closes the group");
  await e(`(async()=>{
    experienceTurns[2].content.push({type:'tool_use',id:'pending-plan',name:'Pi/todo',input:{action:'update',id:2,status:'in_progress'}});
    experienceTurns.pop();h.publish(experienceTurns,{status:'running',structuredState:{inFlight:true}});h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e("document.querySelectorAll('.chat-process-summary .ant-spin').length"),1,"only the overview animates");
  assert.equal(await e("document.querySelectorAll('.chat-call .ant-spin').length"),0);
  await e(`(async()=>{
    experienceTurns[2].content.push({type:'tool_result',tool_use_id:'pending-plan',content:'Updated #2'});
    h.publish(experienceTurns,{status:'idle',structuredState:{inFlight:false}});h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e("document.querySelectorAll('.chat-process-summary .ant-spin').length"),0,"completed receipts settle the overview");
  // Independent tools keep real identity, a bounded heading and details behind one control.
  await e(`h.fresh([{role:'assistant',uuid:'generic',content:[{type:'tool_use',id:'generic',name:'Plugin/search',input:{description:'说明文字'.repeat(150),query:'界面层级'}},{type:'tool_result',tool_use_id:'generic',content:'完整工具输出'}]}])`);
  const generic=await e(`(()=>{const card=document.querySelector('.chat-tool-card'),button=card.querySelector('button');return {title:button.innerText,height:button.getBoundingClientRect().height,cardHeight:card.getBoundingClientRect().height,body:card.querySelector('.chat-disclosure-body').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
  assert.match(generic.title,/Plugin\/search/);
  assert.ok(generic.height<=44&&generic.cardHeight<=45);
  assert.equal(generic.body,0);assert.equal(generic.overflow,false);
  await click('.chat-tool-header');await e('h.frames()');
  assert.equal(await e("document.querySelector('.chat-tool-body').innerText.includes('完整工具输出')"),true);
  result.cases.push({mode,name:"readable conversation hierarchy",stats,rows,generic,ok:true});
}
