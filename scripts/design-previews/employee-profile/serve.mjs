import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
const repo = resolve(import.meta.dirname,"../../..");
const require = createRequire(join(repo, "package.json"));
const { build } = require("esbuild");
const root = import.meta.dirname;
const out = join(root, "build"); mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(root,"main.tsx")], outfile:join(out,"app.js"), bundle:true, platform:"browser", format:"iife", jsx:"automatic", target:"es2022", nodePaths:[join(repo,"node_modules")], alias:{"@wand":repo}, define:{"process.env.NODE_ENV":'"production"'}, minify:true,
  plugins:[{name:"local-plush-path",setup(b){b.onLoad({filter:/\/avatars\/plush-avatar\.tsx$/},args=>({contents:readFileSync(args.path,"utf8").replace('${plushAvatarChunkSrc}',"/assets/plush-avatar.js"),loader:"tsx"}));}}] });
await build({ entryPoints:[join(repo,"src/web-ui/react/avatars/renderer.ts")], outfile:join(out,"plush-avatar.js"), bundle:true, platform:"browser", format:"iife", target:"es2022", minify:true });
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wand · 员工资料设计预览</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const inlineScript=name=>readFileSync(join(out,name),"utf8").replace(/<\/script/gi,"<\\/script");
writeFileSync(join(root,"Wand-employee-profile-preview.html"),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><title>Wand · 员工资料设计预览</title><style>${readFileSync(join(out,"app.css"),"utf8")}</style></head><body><div id="root"></div><script>${inlineScript("plush-avatar.js")}</script><script>${inlineScript("app.js")}</script></body></html>`);
const server=createServer((req,res)=>{
 if(req.method!=="GET"){res.writeHead(405);res.end("Read-only preview server");return;}
 const pathname=new URL(req.url,"http://127.0.0.1").pathname;
 const names={"/app.js":"app.js","/app.css":"app.css","/assets/plush-avatar.js":"plush-avatar.js"};
 if(pathname==="/"||pathname==="/index.html"){res.setHeader("Content-Type","text/html;charset=utf-8");res.end(html);return;}
 if(!names[pathname]){res.writeHead(404);res.end("Not found");return;}
 res.setHeader("Content-Type",pathname.endsWith("css")?"text/css":"text/javascript");res.end(readFileSync(join(out,names[pathname])));
});
server.listen(8794,"127.0.0.1",()=>console.log("Employee profile isolated preview http://127.0.0.1:8794"));
