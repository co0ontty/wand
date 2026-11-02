import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const output = join(root, "output/taskboard-dashi-polish");
mkdirSync(output, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, "main.tsx")], outfile: join(output, "preview.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "preview-memory-storage", setup(builder) {
  builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
    if (args.path.includes("node_modules")) return;
    const source = readFileSync(args.path, "utf8");
    if (!source.includes("window.localStorage") && !source.includes("window.sessionStorage")) return;
    const storage = "const previewStorage = ((globalThis as any).__wandPreviewStorage ??= (() => {const values = new Map<string,string>(); return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};})());\n";
    return { loader: args.path.endsWith("tsx") ? "tsx" : "ts", contents: storage + source.replaceAll("window.localStorage", "previewStorage").replaceAll("window.sessionStorage", "previewStorage") };
  });
} }] });
const css = readFileSync(join(root, "src/web-ui/content/styles.css"), "utf8") + `
html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column;background:var(--bg-primary)}
.taskboard-preview-banner{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;padding:4px 20px;border-bottom:1px solid var(--border-subtle);font-size:12px;color:var(--text-secondary);flex-shrink:0}
.taskboard-preview-stage{position:relative;flex:1;min-height:0;min-width:0}
@media(max-width:600px){.taskboard-preview-banner{padding-inline:12px;font-size:11px}}
`;
const script = readFileSync(join(output, "preview.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
writeFileSync(join(output, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Wand · 任务面板优化预览</title><style>${css}</style></head><body><div id="root" data-wand-ui-root></div><div id="portals" data-wand-ui-root></div><script>${script}</script></body></html>`);
console.log(join(output, "index.html"));
