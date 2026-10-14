// Production cat avatars, real Chrome/WebGL; no model or employee writes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";
const root=resolve(import.meta.dirname,"../.."), output=resolve(process.env.WAND_CAT_OUTPUT || "output/architecture-stage2/cat-breed-avatars/browser");mkdirSync(output,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),"wand-cat-breeds-"));
await build({stdin:{resolveDir:root,loader:"tsx",contents:`
 import * as React from 'react';import {createRoot} from 'react-dom/client';
 import {EmployeeAvatar} from './src/web-ui/react/agents/employee-avatar';
 import {PlushAvatar} from './src/web-ui/react/avatars/plush-avatar';
 import {parsePlushCatAvatar} from './src/plush-avatar';
 import {WandUiProvider} from './src/web-ui/react/theme';import {setWandTheme} from './src/web-ui/react/theme-preference';
 import {Flex,Typography} from 'antd';
 window.catFixture={theme:setWandTheme};
 const cats=[{id:'e_wand_default',systemKey:'wand-default',name:'虎妞 · 银渐层',avatar:'plush-cat:v1:silver'},
 {id:'e_wand_ops',systemKey:'wand-ops',name:'初二 · 加菲猫',avatar:'plush-cat:v1:orange'}];
 function Gallery(){const [speaking,setSpeaking]=React.useState(false);window.catFixture.speak=setSpeaking;return <WandUiProvider><main className='cat-fixture'>
 <Typography.Title level={3}>初二与虎妞 · 三维捏脸预览</Typography.Title><Typography.Text type='secondary'>照片仅作造型参考 · 没有照片贴图 · 尚未替换现有头像</Typography.Text><div className='cat-gallery'>
 {cats.map(cat=><section className='cat-card' key={cat.id} data-cat-id={cat.id}><Typography.Title level={4}>{cat.name}</Typography.Title>
 <div className='cat-portrait'><PlushAvatar config={parsePlushCatAvatar(cat.avatar)} size={240} interactive speaking={speaking}/></div>
 <Flex align='end' justify='center' gap={12}>{['sm','md','composer'].map(size=><div key={size}><EmployeeAvatar employee={cat} provider='' size={size}/><small>{{sm:'36px',md:'48px',composer:'72px'}[size]}</small></div>)}</Flex>
 </section>)}</div><Flex gap={12} align='center' className='unchanged-avatars'>
 <EmployeeAvatar employee={{id:'e_wand_hr',name:'嘟嘟',avatar:'plush-dog:v1:shiba:red-scarf'}} provider='' size='md'/>
 <EmployeeAvatar employee={{id:'ordinary',name:'普通员工',avatar:'plush:v1:heart:coral:none:none'}} provider='' size='md'/>
 <Typography.Text type='secondary'>嘟嘟与普通头像保持原样</Typography.Text></Flex></main></WandUiProvider>}
 createRoot(document.getElementById('root')).render(<Gallery/>);
`},bundle:true,platform:"browser",format:"iife",jsx:"automatic",outfile:join(temp,"app.js"),define:{"process.env.NODE_ENV":'"production"'}});
await build({entryPoints:[join(root,"src/web-ui/react/avatars/renderer.ts")],bundle:true,platform:"browser",format:"iife",minify:true,outfile:join(temp,"plush-avatar.js")});
writeFileSync(join(temp,"app.js"),readFileSync(join(temp,"app.js"),"utf8").replaceAll("${plushAvatarChunkSrc}","/plush-avatar.js"));
if(process.env.WAND_CAT_PREVIEW_EXPORT==='1'){
 const escape=source=>source.replaceAll('</script','<\\/script');
 const css=readFileSync(join(root,'src/web-ui/content/styles.css'),'utf8');
 const page='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'"><title>初二与虎妞 · 三维捏脸预览</title><style>'+css+'body{margin:0;background:var(--bg-primary)}.cat-fixture{padding:20px}.cat-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:24px}.cat-card h4{text-align:center}.cat-portrait{display:flex;justify-content:center;padding:8px 0 12px}.cat-card small{display:block;text-align:center;color:var(--text-secondary)}.unchanged-avatars{margin-top:20px}</style><body><div id="root" data-wand-ui-root></div><script>'+escape(readFileSync(join(temp,'plush-avatar.js'),'utf8'))+'</script><script>'+escape(readFileSync(join(temp,'app.js'),'utf8'))+'</script></body></html>';
 writeFileSync(join(output,'preview.html'),page);
}
let mutations=0;
const server=createServer((req,res)=>{
 const path=new URL(req.url,"http://fixture.invalid").pathname;
 if(req.method!=='GET'){mutations++;res.writeHead(403);return res.end('No writes');}
 const files={'/app.js':[join(temp,'app.js'),'text/javascript'],'/plush-avatar.js':[join(temp,'plush-avatar.js'),'text/javascript'],'/styles.css':[join(root,'src/web-ui/content/styles.css'),'text/css']};
 if(files[path]){res.setHeader('Content-Type',files[path][1]);return res.end(readFileSync(files[path][0]));}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:var(--bg-primary)}.cat-fixture{padding:20px}.cat-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:24px}.cat-card h4{text-align:center}.cat-portrait{display:flex;justify-content:center;padding:8px 0 12px}.cat-card small{display:block;text-align:center;color:var(--text-secondary)}.unchanged-avatars{margin-top:20px}</style><body><div id="root" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const report={ok:false,productionOwners:true,modelCalls:0,mutations:0,cases:[]};
try{
 for(const fallback of [false,true]){
  const b=await openPlushBrowser(1440,1000,fallback,'reduce');
  try{
   await b.send('Page.navigate',{url:origin});await b.wait("!!window.catFixture");
   await b.wait(fallback?"document.querySelectorAll('[data-renderer=fallback]').length===10":"document.querySelectorAll('[data-renderer=webgl]').length===10");
   for(const [name,width,theme] of [['desktop',1440,'warm'],['phone',390,'warm'],['dark-small',320,'graphite']]){
    await b.send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
    await b.evaluate(`catFixture.theme(${JSON.stringify(theme)});true`);await b.settle();
    const info=await b.evaluate(`(()=>{const cats=[...document.querySelectorAll('.cat-card')].map(n=>({id:n.dataset.catId,breed:n.querySelector('[data-avatar-breed]').dataset.avatarBreed,renderers:[...n.querySelectorAll('[data-plush-avatar]')].map(p=>p.dataset.renderer)}));return{overflow:document.documentElement.scrollWidth>innerWidth,cats}})()`);
    assert.equal(info.overflow,false);assert.deepEqual(info.cats.map(c=>c.breed),['sculpted-huniu','sculpted-chuer']);
    if(!fallback){const pixels=await b.evaluate(`([...document.querySelectorAll('.cat-portrait canvas')].map(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let filled=0,border=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(d[(y*c.width+x)*4+3]>20){filled++;if(x===0||y===0||x===c.width-1||y===c.height-1)border++}return{filled,border,size:c.width}}))`);for(const p of pixels){assert.ok(p.filled>p.size*p.size*.15);assert.equal(p.border,0,'ear and cheek silhouette must not be clipped');}info.pixels=pixels;}
    await b.screenshot(join(output,`${fallback?'fallback':'webgl'}-${name}.png`));report.cases.push({name,width,fallback,...info});
   }
   assert.equal(await b.evaluate("document.querySelectorAll('.cat-card img,.cat-card image').length"),0,'cat appearance has no photograph nodes');
   if(!fallback){
    await b.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await b.evaluate("catFixture.theme('warm');true");
    await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await b.wait("[...document.querySelectorAll('.cat-portrait [data-plush-avatar]')].every(n=>n.dataset.renderState==='active')");
    const canvas=".cat-portrait canvas",before=await b.evaluate(`document.querySelector('${canvas}').dataset.sceneRotation`);
    const point=await b.evaluate(`(()=>{const r=document.querySelector('${canvas}').getBoundingClientRect();return{x:r.right-8,y:r.top+20}})()`);
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await b.wait(`document.querySelector('${canvas}').dataset.sceneRotation!==${JSON.stringify(before)}`);
    await b.evaluate("catFixture.speak(true);true");
    await b.wait("Number(document.querySelector('.cat-portrait canvas').dataset.mouthScale)>0.035");
    await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await b.wait("[...document.querySelectorAll('.cat-portrait [data-plush-avatar]')].every(n=>n.dataset.renderState==='static')");
    await b.evaluate("catFixture.speak(false);true");
    const diagnostics=await b.evaluate("window.__wandPlushDiagnostics()");
    assert.equal(diagnostics.createdContexts,1);assert.ok(diagnostics.geometryBytes<=48*1024*1024);
    assert.equal(diagnostics.animated,0);
    report.motion={pointerRotation:true,speaking:true,reducedMotion:true,contexts:diagnostics.createdContexts,geometryBytes:diagnostics.geometryBytes};
   }
   assert.deepEqual(b.errors,[]);
  }finally{await b.close();}
 }
 assert.equal(mutations,0);report.ok=true;
}catch(error){report.error=error.message;throw error;}
finally{report.mutations=mutations;writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,cases:report.cases.length,modelCalls:0,mutations}));}
