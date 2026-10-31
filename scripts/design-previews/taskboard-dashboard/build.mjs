import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const repo = resolve(import.meta.dirname, "../../..");
export const output = join(repo, "output/taskboard-dashboard");
mkdirSync(output, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, "main.tsx")], outfile: join(output, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "preview-memory-theme", setup(builder) {
  builder.onLoad({ filter: /\/theme-preference\.ts$/ }, args => ({ loader: "ts", contents: "const values=new Map<string,string>(); const previewStorage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};\n" + readFileSync(args.path, "utf8").replaceAll("window.localStorage", "previewStorage") }));
} }] });
const css = readFileSync(join(repo, "src/web-ui/content/styles.css"), "utf8") + "\n" + readFileSync(join(output, "app.css"), "utf8");
const script = readFileSync(join(output, "app.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
writeFileSync(join(output, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Wand · 完整任务面板设计稿</title><style>${css}</style></head><body><div id="root" data-wand-ui-root></div><script>${script}</script></body></html>`);
console.log(join(output, "index.html"));
