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
  assert.equal(stats.hiddenDetail, 0);
  assert.equal(stats.overflow, false);
  if (output) {
    const shot=await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(join(dirname(output),`experience-${mode}-collapsed.png`),Buffer.from(shot.data,"base64"));
  }
  await click(summary); await e("h.frames()");
  assert.equal(await e("document.querySelector('.chat-activity').dataset.expanded"),"true");
  const rows = await e(`(()=>({thinking:[...document.querySelectorAll('.chat-call[data-thinking-entry]')].map(n=>({height:n.querySelector('button').getBoundingClientRect().height,state:n.dataset.status,text:n.querySelector('button').innerText,mark:n.querySelector('.chat-call-mark')?getComputedStyle(n.querySelector('.chat-call-mark')).backgroundColor:'',clock:n.querySelector('.chat-call-time')?.innerText||''})),tools:[...document.querySelectorAll('.chat-call[data-tool-ids]')].map(n=>({height:n.querySelector('button').getBoundingClientRect().height,status:n.dataset.status,label:n.querySelector('.chat-call-label')?.innerText||'',preview:n.querySelector('.chat-call-preview')?getComputedStyle(n.querySelector('.chat-call-preview')).fontFamily:'',result:n.querySelector('.chat-call-result')?.innerText||'',mark:n.querySelector('.chat-call-mark')?getComputedStyle(n.querySelector('.chat-call-mark')).backgroundColor:'',state:!!n.querySelector('.chat-call-meta')})),height:document.querySelector('.chat-activity-timeline').getBoundingClientRect().height,rail:(()=>{const box=document.querySelector('.chat-activity-timeline').getBoundingClientRect();const calls=[...document.querySelectorAll('.chat-call')];return calls.map((n,i)=>{const r=n.getBoundingClientRect();const mark=n.querySelector('.chat-call-mark')?.getBoundingClientRect();return {i,top:Math.round(r.top-box.top),bottom:Math.round(r.bottom-box.top),left:Math.round(r.left-box.left),dotCenter:mark?Math.round(mark.top-r.top+mark.height/2):null,dotLeft:mark?Math.round(mark.left-box.left):null,railTop:Math.round(Number.parseFloat(getComputedStyle(n,"::before").top)||0),railBottom:Math.round(Number.parseFloat(getComputedStyle(n,"::before").bottom)||0)}})})(),overflow:document.documentElement.scrollWidth>innerWidth+1}))()`);
  // 竖线只连接首末状态点：首行从点中心开始，末行在点中心结束，中间行贯穿，行与行不断开。
  const rail = rows.rail;
  assert.ok(rail.length > 2, "timeline renders several rows");
  assert.equal(rail[0].railTop, rail[0].dotCenter, "the rail starts at the first dot centre");
  const lastRow = rail[rail.length - 1];
  assert.equal(lastRow.railBottom, Math.round(lastRow.bottom - lastRow.top) - lastRow.dotCenter, "the rail stops at the last dot centre");
  assert.ok(rail.slice(1, -1).every(row => row.railTop === 0 && row.railBottom === 0), "middle rows carry a full-height rail");
  assert.ok(rail.every((row, index) => index === 0 || row.top === rail[index - 1].bottom), "rail segments meet without a gap");
  assert.ok(rail.every(row => row.dotLeft === row.left + 3), "the status dot is centred in its 12px slot");
  assert.equal(rows.thinking.length, 2);
  assert.ok(rows.thinking.every(row=>row.height<=48&&row.state==="complete"), "思考轮次是单行紧凑行");
  // Android 时间线行：时钟 + 标签一行，输入/结果摘录各一行；状态只由左侧点颜色表达，不写状态字样。
  assert.ok(rows.tools.every(row=>row.height<=88), "tool rows keep the label plus input/result excerpt, not cards");
  assert.ok(rows.tools.every(row=>row.state===false), "rows do not repeat the status as text");
  assert.ok(rows.tools.every(row=>row.mark!=="rgba(0, 0, 0, 0)"), "every row carries a status dot");
  assert.ok(rows.tools.every(row=>row.preview.includes("mono")), "excerpts stay monospace");
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
  // 运行标记是全段唯一的动态 loading：九点在同一个实例里从中心展开，不在时间线行再来一份。
  const runningMark = await e(`(()=>{const dots=[...document.querySelectorAll('.chat-process-summary-dot i')];const rects=dots.map(n=>n.getBoundingClientRect());const first=dots[0];return {dots:dots.length,count:document.querySelectorAll('.chat-process-summary-dot').length,rowMarks:document.querySelectorAll('.chat-call .chat-process-summary-dot').length,columns:new Set(rects.map(r=>Math.round(r.left))).size,rows:new Set(rects.map(r=>Math.round(r.top))).size,size:first?getComputedStyle(first).width:'',animation:first?getComputedStyle(first).animationName:'',running:document.querySelector('.chat-activity')?.classList.contains('is-command-running')??false}})()`);
  assert.equal(runningMark.count,1,"only the overview animates");
  assert.equal(runningMark.rowMarks,0);
  assert.equal(runningMark.dots,9,"the running mark keeps one nine-dot instance");
  assert.equal(runningMark.running,true,"the live turn marks itself as running");
  if (mode.includes("reduce")) {
    // Android ToolActivityMark：reduce-motion 下不流动、不展开，只保留状态色。
    assert.equal(runningMark.columns,1,"reduced motion keeps the mark collapsed to one dot");
    assert.equal(runningMark.rows,1);
    assert.equal(runningMark.animation,"none");
  } else {
    assert.equal(runningMark.columns,3,"running spreads the nine dots into three columns");
    assert.equal(runningMark.rows,3,"running spreads the nine dots into three rows");
    assert.equal(runningMark.size,"2px","spread dots keep the Android 6dp mark size");
    assert.equal(runningMark.animation,"wand-activity-mark-flow","the overview mark flows while the turn runs");
  }
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
  // Android 消息形态：时间行 + 署名行在正文之上，用量独立成行；自己的发言是品牌色气泡。
  const messageShape = await e(`(()=>{
    const asst=[...document.querySelectorAll('.chat-message.assistant')].find(n=>n.querySelector('.assistant-reply-head'));
    const head=asst?.querySelector('.assistant-reply-head');
    const user=[...document.querySelectorAll('.chat-message.user')].find(n=>n.querySelector('.ant-bubble-content'));
    const cs=user?getComputedStyle(user.querySelector('.ant-bubble-content')):null;
    const usage=document.querySelector('.turn-usage-summary');
    return {
      headTime: !!head?.querySelector('.chat-message-time'),
      headTimeBeforeControl: (()=>{const t=head?.querySelector('.chat-message-time');const b=head?.querySelector('.assistant-reply-disclosure');return !t||!b?true:(t.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)>0;})(),
      authorName: head?.querySelector('.assistant-author-name')?.innerText||'',
      authorAvatar: !!head?.querySelector('.assistant-author-avatar'),
      authorAvatarKind: head?.querySelector('.assistant-author-avatar .wand-employee-avatar') ? 'employee' : head?.querySelector('.assistant-author-spark') ? 'brand' : 'none',
      replyAction: head?.querySelector('.assistant-reply-action')?.innerText||'',
      contentBorderless: (()=>{const c=asst?.querySelector('.ant-bubble-content'); if(!c) return null; const s=getComputedStyle(c); return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.padding==='0px';})(),
      usageOutsideContent: !!usage && !usage.closest('.chat-message-content'),
      usageMono: usage?getComputedStyle(usage).fontFamily.includes('mono'):null,
      userRadius: cs?.borderRadius||'', userBorder: cs?.borderTopWidth||'', userPadding: cs?.padding||'',
      userFont: cs?cs.fontSize+'/'+cs.lineHeight:'',
      timeOutsideBubble: !!user?.querySelector('.ant-bubble-header .chat-message-time'),
    };
  })()`);
  assert.equal(messageShape.headTime,true,"the assistant header carries the message clock");
  assert.equal(messageShape.headTimeBeforeControl,true,"the clock sits above the author row");
  assert.equal(messageShape.authorAvatar,true,"the assistant header carries an author mark");
  // 身份来自会话快照：署名就该是这条会话的员工，而不是通用的 Wand。
  assert.equal(messageShape.authorName,"Wand 助手","the assistant header names the session employee");
  assert.equal(messageShape.authorAvatarKind,"employee","the session employee avatar replaces the generic brand mark");
  assert.equal(messageShape.replyAction.length>0,true,"the header owns the expand/collapse control");
  assert.equal(messageShape.contentBorderless,true,"the assistant body has no bubble chrome");
  assert.equal(messageShape.usageOutsideContent,true,"usage is its own row after the reply");
  assert.equal(messageShape.usageMono,true,"usage reads in the monospace scale");
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
