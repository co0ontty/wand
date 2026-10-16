import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
      {role:'assistant',uuid:'reply-intro',createdAt:'2026-10-07T12:26:05Z',completedAt:'2026-10-07T12:26:09Z',usage:{inputTokens:1412,cacheReadInputTokens:186803,outputTokens:292},content:[{type:'text',text:'我会先核对实际页面，再整理正文、执行过程和工具详情的层级。'}]},
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
    // 会话 DTO 自带员工快照：署名直接读它（团队 relay 的 msg.author 次之，最后才是 Wand）。
    h.publish(experienceTurns,{employeeId:'fixture_assistant',employeeName:'Wand 助手',employeeAvatar:''});
    h.doRenderChat(false);await h.frames();
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
  assert.equal(stats.hiddenDetail, 0, "the process stays folded until the reader opens it");
  assert.equal(await e("document.querySelectorAll('.chat-call[data-thinking-entry][data-expanded=\"true\"]').length"), 0, "full thinking bodies are not expanded by default");
  assert.equal(stats.overflow, false);
  if (output) {
    const shot=await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(join(dirname(output),`experience-${mode}-collapsed.png`),Buffer.from(shot.data,"base64"));
  }
  // Optional evidence capture uses real CDP clicks and unmodified production timing.
  if (output && process.env.WAND_CHAT_CAPTURE_MOTION === "1" && mode === "desktop") {
    const directory = join(dirname(output), "motion");
    mkdirSync(directory, { recursive: true });
    const frames: { file: string; at: number }[] = [];
    const started = Date.now();
    for (let index = 0; index < 32; index++) {
      if (index === 4 || index === 20) {
        const point = await e(`(()=>{const r=document.querySelector(${JSON.stringify(summary)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      }
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const file = `frame-${String(index).padStart(3, "0")}.png`;
      writeFileSync(join(directory, file), Buffer.from(shot.data, "base64"));
      frames.push({ file, at: Date.now() - started });
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    writeFileSync(join(directory, "frames.json"), JSON.stringify({ frames, evidence: "Chrome captures with original motion tokens; native clicks at frames 4 and 20" }, null, 2));
    await e("h.frames()");
    assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"), "false");
  }
  await click(summary);
  await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"),"true");
  const rows = await e(`(()=>({thinking:[...document.querySelectorAll('.chat-call[data-thinking-entry]')].map(n=>({height:n.querySelector('button').getBoundingClientRect().height,state:n.dataset.status,text:n.querySelector('button').innerText,icon:n.querySelector('[data-wand-icon]')?.dataset.wandIcon,body:n.querySelector('.chat-activity-thinking-content')?.innerText,open:n.dataset.expanded})),tools:[...document.querySelectorAll('.chat-call[data-tool-ids]')].map(n=>({height:n.querySelector('button').getBoundingClientRect().height,status:n.dataset.status,label:n.querySelector('.chat-call-label')?.innerText||'',icon:n.querySelector('[data-wand-icon]')?.dataset.wandIcon,result:n.querySelector('.chat-call-result')?.innerText||'',state:!!n.querySelector('.chat-call-meta')})),viewport:document.querySelector('.chat-messages').clientHeight,height:document.querySelector('.chat-activity-timeline').getBoundingClientRect().height,timelineOverflow:getComputedStyle(document.querySelector('.chat-activity-timeline')).overflowY,overflow:document.documentElement.scrollWidth>innerWidth+1}))()`);
  assert.equal(rows.thinking.length, 2);
  assert.ok(rows.thinking.every(row=>row.height<=48&&row.state==="complete"&&row.open==="false"&&row.icon==="brain"&&!row.body), "thinking rounds stay single-line until their row is opened");
  assert.ok(rows.tools.every(row=>row.height<=110), "tool rows remain bounded while showing meaningful action titles");
  assert.ok(rows.tools.every(row=>row.icon), "actual action icons replace anonymous dots");
  assert.ok(rows.tools.some(row=>row.label.includes("核对截图")), "task subjects carry the primary hierarchy");
  assert.ok(rows.tools.some(row=>row.label==="运行界面回归"&&row.status==="error"), "failed command retains its supplied intent");
  assert.equal(rows.timelineOverflow,"auto", "the timeline scrolls inside its own bounded window");
  assert.ok(Math.abs(rows.height - Math.round(Math.max(120, Math.min(240, rows.viewport / 3)))) <= 1, "the timeline honors the viewport-third window: "+JSON.stringify(rows.height)+" "+rows.viewport);
  assert.equal(rows.overflow,false);
  // 手动展开的思考条目是阅读选择：换一次绘制也不会被重置。
  await click('.chat-call[data-thinking-entry] .chat-call-button');
  await e("h.doRenderChat(false);h.frames()");
  assert.equal(await e("document.querySelector('.chat-call[data-thinking-entry]').dataset.expanded"),"true","an explicitly opened thought survives repaint");
  await click('.chat-call[data-thinking-entry] .chat-call-button');
  await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-call[data-thinking-entry]').dataset.expanded"),"false","the reader can fold it again");
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
  // One semantic icon represents live work; it settles immediately under reduced motion.
  const runningMark = await e(`(()=>{const mark=document.querySelector('.chat-process-summary-dot');return{count:document.querySelectorAll('.chat-process-summary-dot').length,rowMarks:document.querySelectorAll('.chat-call .chat-process-summary-dot').length,icons:mark?.querySelectorAll('svg').length||0,animation:mark?getComputedStyle(mark).animationName:'',running:document.querySelector('.chat-activity')?.classList.contains('is-command-running')??false}})()`);
  assert.equal(runningMark.count,1,"only the overview animates");
  assert.equal(runningMark.rowMarks,0);
  assert.equal(runningMark.icons,1,"one clear semantic icon replaces the nine-dot logo");
  assert.equal(runningMark.running,true);
  assert.equal(runningMark.animation,mode.includes("reduce")?"none":"wand-activity-mark-flow");
  if (output) {
    const mark = await e(`(()=>{const n=document.querySelector('.chat-process-summary');if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const shot = await send("Page.captureScreenshot",{format:"png",clip:{...mark,scale:2}});
    writeFileSync(join(dirname(output),`experience-${mode}-running-mark.png`),Buffer.from(shot.data,"base64"));
  }
  await e(`(async()=>{
    experienceTurns[2].content.push({type:'tool_result',tool_use_id:'pending-plan',content:'Updated #2'});
    h.publish(experienceTurns,{status:'idle',structuredState:{inFlight:false}});h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e("document.querySelectorAll('.chat-process-summary-dot').length"),0,"completed receipts settle the overview");
  // Android 消息形态：时间行 + 署名行在正文之上；自己的发言是品牌色气泡。
  const messageShape = await e(`(()=>{
    const asst=[...document.querySelectorAll('.chat-message.assistant')].find(n=>n.querySelector('.assistant-reply-head'));
    const head=asst?.querySelector('.assistant-reply-head');
    const user=[...document.querySelectorAll('.chat-message.user')].find(n=>n.querySelector('.wand-chat-message-content'));
    const cs=user?getComputedStyle(user.querySelector('.wand-chat-message-content')):null;
    return {
      headTime: !!head?.querySelector('.chat-message-time'),
      headTimeInControl: !!head?.querySelector('.assistant-reply-disclosure .chat-message-time'),
      authorName: head?.querySelector('.assistant-author-name')?.innerText||'',
      authorAvatar: !!head?.querySelector('.assistant-author-avatar'),
      authorAvatarKind: head?.querySelector('.assistant-author-avatar .wand-employee-avatar') ? 'employee' : head?.querySelector('.assistant-author-spark') ? 'brand' : 'none',
      replyAction: head?.querySelector('.assistant-reply-action')?.innerText||'',
      contentBorderless: (()=>{const c=asst?.querySelector('.wand-chat-message-content'); if(!c) return null; const s=getComputedStyle(c); return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.padding==='0px';})(),
      usageRows: document.querySelectorAll('.turn-usage-summary').length,
      userRadius: cs?.borderRadius||'', userBorder: cs?.borderTopWidth||'', userPadding: cs?.padding||'',
      userFont: cs?cs.fontSize+'/'+cs.lineHeight:'',
      timeOutsideBubble: !!user?.querySelector('.wand-chat-message-header .chat-message-time'),
    };
  })()`);
  assert.equal(messageShape.headTime,true,"the assistant header carries the message clock");
  assert.equal(messageShape.headTimeInControl,true,"the clock shares the author disclosure row");
  assert.equal(messageShape.authorAvatar,true,"the assistant header carries an author mark");
  // 身份来自会话快照：署名就该是这条会话的员工，而不是通用的 Wand。
  assert.equal(messageShape.authorName,"Wand 助手","the assistant header names the session employee");
  assert.equal(messageShape.authorAvatarKind,"employee","the session employee avatar replaces the generic brand mark");
  assert.equal(messageShape.replyAction.length>0,true,"the header owns the expand/collapse control");
  assert.equal(messageShape.contentBorderless,true,"the assistant body has no bubble chrome");
  assert.equal(messageShape.usageRows,0,"the transcript keeps no per-turn usage row");
  assert.equal(messageShape.timeOutsideBubble,true,"the message clock sits above the user bubble");
  // 右下 6px 是气泡「尾巴」，其余 20px；浏览器会把第 4 个值与第 2 个相同的写法收成三值。
  assert.match(messageShape.userRadius,/^20px 20px 6px( 20px)?$/);
  assert.ok(Number.parseFloat(messageShape.userBorder)>=1,"the user bubble carries a rim");
  assert.equal(messageShape.userPadding,"8px 13px");
  assert.equal(messageShape.userFont,"15px/21px");
  // Independent tools keep real identity, a bounded heading and details behind one control.
  await e(`h.fresh([{role:'assistant',uuid:'generic',content:[{type:'tool_use',id:'generic',name:'Plugin/search',input:{description:'说明文字'.repeat(150),query:'界面层级'}},{type:'tool_result',tool_use_id:'generic',content:'完整工具输出'}]}])`);
  // Android ToolCard：一张 14dp 圆角的描边卡，头部是 34dp 图标槽 + 标题/摘要两行 + 箭头。
  const generic=await e(`(()=>{const card=document.querySelector('.chat-tool-card'),button=card.querySelector('button');const slot=button.querySelector('.chat-tool-icon-slot');const r=card.getBoundingClientRect();const cs=getComputedStyle(card.querySelector('.chat-tool-surface'));return {title:button.innerText,height:button.getBoundingClientRect().height,cardHeight:r.height,radius:cs.borderRadius,border:cs.borderTopWidth,slot:slot?Math.round(slot.getBoundingClientRect().width):0,summary:getComputedStyle(button.querySelector('.chat-tool-summary')).fontFamily,state:!!button.querySelector('.chat-tool-state'),label:button.getAttribute('aria-label'),body:card.querySelector('.chat-disclosure-body').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
  assert.match(generic.title,/Plugin\/search/);
  assert.ok(generic.height>=48&&generic.height<=64, "the Android card header keeps the 34px icon slot plus two text lines "+JSON.stringify(generic));
  assert.ok(generic.cardHeight<=generic.height+4, "the card adds a rim, not extra rows");
  assert.equal(generic.slot,34);
  assert.match(generic.radius,/\d+px/);
  assert.ok(Number.parseFloat(generic.border)>=1, "the tool card carries a visible rim");
  assert.equal(generic.state,false, "the card does not repeat its status as text");
  assert.match(generic.label,/Plugin\/search/,"the status stays reachable through the label");
  assert.equal(generic.body,0);assert.equal(generic.overflow,false);
  await click('.chat-tool-header');await e('h.frames()');
  assert.equal(await e("document.querySelector('.chat-tool-body').innerText.includes('完整工具输出')"),true);
  result.cases.push({mode,name:"readable conversation hierarchy",stats,rows,generic,ok:true});
}
