import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
export interface PageLayoutQaCase {
  width: number;
  condition: string;
  zoomEquivalent?: boolean;
  safeArea?: boolean;
  reducedMotion?: boolean;
  prepare(): Promise<void>;
}

/** Laboratory instrumentation only; never connects to the installed Wand service. */
export async function installLayoutShiftObserver(send: Send): Promise<void> {
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__wandLayoutShifts=[];
    try { new PerformanceObserver(list=>{for(const e of list.getEntries())window.__wandLayoutShifts.push({value:e.value,startTime:e.startTime,hadRecentInput:e.hadRecentInput,sources:e.sources?.map(s=>({tag:s.node?.tagName,id:s.node?.id,className:String(s.node?.className??''),previousRect:s.previousRect.toJSON(),currentRect:s.currentRect.toJSON()}))})}).observe({type:'layout-shift',buffered:true}); }
    catch { window.__wandLayoutShiftUnsupported=true; }
  ` });
}

function collectPageLayout(options: {
  rootSelector: string; titleSelector: string; secondarySelector: string;
  buttonSelector: string; disabledSelector?: string;
}) {
  const visible = (n: Element) => { const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"; };
  const rgba = (value: string): number[] => { const n=value.match(/[\d.]+/g)?.map(Number);return n?.length ? [n[0]!,n[1]!,n[2]!,n[3]??1] : [0,0,0,0]; };
  const over = (fg: number[], bg: number[]) => [0,1,2].map(i=>fg[i]!*fg[3]!+bg[i]!*(1-fg[3]!));
  const luminance = (c: number[]) => c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i]!,0);
  const contrast: any[]=[];
  for(const [role,selector] of Object.entries({title:options.titleSelector,secondary:options.secondarySelector,button:options.buttonSelector,disabled:options.disabledSelector??"button:disabled"})) {
    for(const n of Array.from(document.querySelectorAll(selector)).filter(visible).slice(0,24)) {
      const s=getComputedStyle(n), chain:Element[]=[];let a:Element|null=n;while(a){chain.unshift(a);a=a.parentElement;}
      let bg=[255,255,255],opacity=1;const images:string[]=[];
      for(const node of chain){const style=getComputedStyle(node);bg=over(rgba(style.backgroundColor),bg);opacity*=Number(style.opacity);if(style.backgroundImage!=="none")images.push(style.backgroundImage);}
      const fg=rgba(s.color);fg[3]=fg[3]!*opacity;const painted=over(fg,bg),l1=luminance(painted),l2=luminance(bg),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
      const large=Number.parseFloat(s.fontSize)>=24||(Number.parseFloat(s.fontSize)>=18.6667&&Number.parseInt(s.fontWeight)>=700);
      const nonText=!n.textContent?.trim()&&Boolean(n.querySelector("svg,img")||n.matches("svg,img"));
      const minimum=large||nonText?3:4.5;
      const exempt=role==="disabled"||n.closest(":disabled,[aria-disabled=true]")!==null;
      contrast.push({role,text:n.textContent?.trim().slice(0,70),nonText,criterion:nonText?"WCAG 1.4.11 non-text":"WCAG 1.4.3 text",foreground:s.color,background:bg.map(v=>Math.round(v)),paintedForeground:painted.map(v=>Math.round(v)),fontSize:s.fontSize,fontWeight:s.fontWeight,ratio:Number(ratio.toFixed(3)),minimum,exempt,passed:exempt||ratio>=minimum,images});
    }
  }
  const root=document.querySelector(options.rootSelector)!;
  const r=root.getBoundingClientRect();
  const intentionalScrollers=Array.from(root.querySelectorAll("*")).filter(n=>visible(n)&&n.scrollWidth>n.clientWidth+1&&["auto","scroll"].includes(getComputedStyle(n).overflowX)).map(n=>({className:n.className,clientWidth:n.clientWidth,scrollWidth:n.scrollWidth}));
  const offenders=Array.from(root.querySelectorAll("*")).filter(n=>visible(n)&&!n.closest(".ant-tooltip,.ant-select-dropdown")).filter(n=>{
    const b=n.getBoundingClientRect();if(b.right<=innerWidth+1&&b.left>=-1)return false;
    let a:Element|null=n.parentElement;while(a&&a!==root){if(["auto","scroll","hidden","clip"].includes(getComputedStyle(a).overflowX))return false;a=a.parentElement;}return true;
  }).slice(0,12).map(n=>({tag:n.tagName,className:n.className,rect:n.getBoundingClientRect().toJSON()}));
  const buttons=Array.from(root.querySelectorAll("header button:not(:disabled)")).filter(visible).filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}).map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {name:n.getAttribute("aria-label")??n.textContent?.trim(),width:r.width,height:r.height,reachable:hit===n||n.contains(hit)};});
  const named=(n:Element)=>Boolean(n.getAttribute("aria-label")||n.getAttribute("aria-labelledby")||n.getAttribute("title")||n.textContent?.trim()||n.querySelector("[aria-label]:not([aria-hidden=true])")?.getAttribute("aria-label"));
  const unnamedButtons=Array.from(root.querySelectorAll("button")).filter(visible).filter(n=>!named(n)).map(n=>n.outerHTML.slice(0,160));
  const spacing=Array.from(root.querySelectorAll("header,.task-board-toolbar,.task-board-toolbar-controls,.wand-settings-library-panel,.wand-settings-library-section-body,.wand-settings-library-grid")).filter(visible).slice(0,16).map(n=>{const s=getComputedStyle(n);return{className:String(n.className),height:n.getBoundingClientRect().height,padding:s.padding,gap:s.gap,rowGap:s.rowGap,columnGap:s.columnGap};});
  const shifts=((window as any).__wandLayoutShifts??[]) as Array<{value:number;startTime:number;hadRecentInput:boolean}>;
  let cls=0,windowSum=0,windowStart=0,last=0;for(const e of shifts.filter(e=>!e.hadRecentInput)){if(e.startTime-last>1000||e.startTime-windowStart>5000){windowSum=0;windowStart=e.startTime;}windowSum+=e.value;last=e.startTime;cls=Math.max(cls,windowSum);}
  return {viewport:{cssWidth:innerWidth,cssHeight:innerHeight,dpr:devicePixelRatio},geometry:{root:r.toJSON(),rootScrollWidth:root.scrollWidth,rootClientWidth:root.clientWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,offenders,intentionalScrollers,headerButtons:buttons,spacing},contrast,semantics:{main:document.querySelectorAll("main,[role=main]").length,nav:document.querySelectorAll("nav,[role=navigation]").length,namedSection:root.tagName==="SECTION"&&named(root),h1:root.querySelectorAll("h1").length,unnamedButtons},performance:{fontStatus:document.fonts.status,time:performance.now(),layoutShiftSupported:!(window as any).__wandLayoutShiftUnsupported,nonRecentInputSum:shifts.filter(e=>!e.hadRecentInput).reduce((v,e)=>v+e.value,0),maxSessionWindowCls:cls,excludedRecentInput:shifts.filter(e=>e.hadRecentInput).length,entries:shifts}};
}

export async function runPageLayoutQa(options: {
  page: string; artifact: string; driver: { send: Send; evaluate(expression: string): Promise<any>; wait(expression: string): Promise<void> };
  cases: PageLayoutQaCase[]; rootSelector: string; titleSelector: string; secondarySelector: string;
  buttonSelector: string; disabledSelector?: string; limitations?: string[];
}): Promise<any[]> {
  const finalSample=process.env.WAND_PAGE_LAYOUT_QA_SAMPLE === "1";
  const artifact=finalSample?join(options.artifact,"final-sample"):options.artifact;
  const cases=finalSample?options.cases.filter(c=>c.width===320&&(c.condition==="normal"||c.condition==="long")):options.cases;
  mkdirSync(artifact,{recursive:true});const records:any[]=[];
  for(const c of cases) {
    const cssWidth=c.zoomEquivalent?Math.floor(c.width/2):c.width,cssHeight=c.zoomEquivalent?500:1000;
    await options.driver.send("Emulation.setDeviceMetricsOverride",{width:cssWidth,height:cssHeight,deviceScaleFactor:c.zoomEquivalent?2:1,mobile:false,screenWidth:c.width,screenHeight:1000});
    await options.driver.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:c.reducedMotion===false?"no-preference":"reduce"}]});
    const safeAreaScript=c.safeArea?await options.driver.send("Page.addScriptToEvaluateOnNewDocument",{source:`
      (()=>{const apply=()=>{if(!document.documentElement)return false;for(const [key,value] of Object.entries({'--wand-safe-top':'24px','--wand-safe-bottom':'34px','--wand-safe-left':'8px','--wand-safe-right':'8px'}))document.documentElement.style.setProperty(key,value);return true;};
      if(!apply()){const observer=new MutationObserver(()=>{if(apply())observer.disconnect()});observer.observe(document,{childList:true,subtree:true})}})();
    `}):null;
    await c.prepare();
    if(safeAreaScript)await options.driver.send("Page.removeScriptToEvaluateOnNewDocument",{identifier:safeAreaScript.identifier});
    await options.driver.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120)))))");
    // tsx preserves function names with __name; the isolated browser needs only its identity shim.
    const evidence=await options.driver.evaluate(`(()=>{const __name=(fn)=>fn;return (${collectPageLayout.toString()})(${JSON.stringify({rootSelector:options.rootSelector,titleSelector:options.titleSelector,secondarySelector:options.secondarySelector,buttonSelector:options.buttonSelector,disabledSelector:options.disabledSelector})})})()`);
    try {
      const ax=await options.driver.send("Accessibility.getFullAXTree");
      evidence.semantics.accessibleButtons=ax.nodes.filter((n:any)=>!n.ignored&&n.role?.value==="button").map((n:any)=>({name:n.name?.value??"",disabled:n.properties?.find((p:any)=>p.name==="disabled")?.value?.value??false}));
    } catch { evidence.semantics.accessibilityTreeUnavailable=true; }
    const focus:any[]=[];
    await options.driver.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(options.rootSelector)})?.querySelector('button:not(:disabled),input:not(:disabled)');n?.focus()})()`);
    for(let i=0;i<4;i++){
      await options.driver.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      await options.driver.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
      focus.push(await options.driver.evaluate("(()=>{const n=document.activeElement,r=n.getBoundingClientRect(),s=getComputedStyle(n);return{tag:n.tagName,name:n.getAttribute('aria-label')||n.getAttribute('title')||n.textContent?.trim().slice(0,80),rect:r.toJSON(),focusVisible:n.matches(':focus-visible'),outline:s.outline,boxShadow:s.boxShadow}})()"));
    }
    const imageName=`${options.page}-${c.width}-${c.condition.replace(/[^\w-]+/g,'-')}${c.zoomEquivalent?'-zoom-equivalent':''}.png`;
    const shot=await options.driver.send("Page.captureScreenshot",{format:"png"});writeFileSync(join(artifact,imageName),Buffer.from(shot.data,"base64"));
    const issues=[...(evidence.geometry.documentOverflow?["document horizontal overflow"]:[]),...evidence.geometry.offenders.map((n:any)=>`outside viewport: ${n.className}`),...evidence.geometry.headerButtons.filter((n:any)=>!n.reachable).map((n:any)=>`obstructed header button: ${n.name}`),...evidence.contrast.filter((n:any)=>!n.passed).map((n:any)=>`text contrast ${n.ratio}: ${n.role} ${n.text}`),...evidence.semantics.unnamedButtons.map(()=>"unnamed visible button")];
    records.push({page:options.page,width:c.width,requestedWidth:c.width,condition:c.condition,reducedMotion:c.reducedMotion!==false,repro:c.zoomEquivalent?"Real isolated Chrome: 200% equivalent emulation, half CSS viewport and deviceScaleFactor=2; not actual browser zoom":c.safeArea?"Real isolated Chrome with CSS safe-area token emulation":"Real isolated Chrome with production-source fixture",evidence:{...evidence,keyboardFocus:focus,screenshot:imageName},fix:null,retest:issues.length?"issues observed":"passed checked scope",issues,limitations:["Isolated API fixtures; installed-instance and real screen-reader acceptance are not covered","Semantic/name checks are custom DOM checks, not axe certification",...(options.limitations??[])]});
    writeFileSync(join(artifact,`${options.page}-layout-qa.json`),JSON.stringify(records,null,2));
  }
  return records;
}
