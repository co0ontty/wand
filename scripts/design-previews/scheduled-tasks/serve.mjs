import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repo = resolve(import.meta.dirname, "../../..");
export const output = join(repo, "output/design-previews/scheduled-tasks");
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="description" content="Wand 定时任务页面的隔离设计预览。所有数据为示例，不触发任何真实任务。"><title>Wand · 定时任务设计预览</title>`;

export async function buildPreview() {
  mkdirSync(output, { recursive: true });
  await build({ entryPoints: [join(import.meta.dirname, "main.tsx")], outfile: join(output, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "preview-theme-memory", setup(builder) {
      builder.onLoad({ filter: /\/theme-preference\.ts$/ }, args => ({ loader: "ts", contents:
        // Keep the production theme owner's behavior, but replace its persistence
        // boundary in this isolated bundle. Even file:// never writes Wand settings.
        "const previewValues = new Map<string, string>(); const previewStorage = { getItem: (key: string) => previewValues.get(key) ?? null, setItem: (key: string, value: string) => { previewValues.set(key, value); } };\n" + readFileSync(args.path, "utf8").replaceAll("window.localStorage", "previewStorage") }));
    } }] });
  await build({ entryPoints: [join(repo, "src/web-ui/react/avatars/renderer.ts")], outfile: join(output, "plush-avatar.js"), bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true });
  const foundation = readFileSync(join(repo, "src/web-ui/content/styles.css"), "utf8");
  writeFileSync(join(output, "foundation.css"), foundation);
  const inlineScript = name => readFileSync(join(output, name), "utf8").replace(/<\/script/gi, "<\\/script");
  const bootstrap = '<script>globalThis.__wandBrowserRuntime={configPath:"",aiTeamsChunkSrc:"",plushAvatarChunkSrc:"/assets/plush-avatar.js"};</script>';
  writeFileSync(join(output, "Wand-scheduled-tasks-preview.html"), `<!doctype html><html lang="zh-CN"><head>${head}<style>${foundation}\n${readFileSync(join(output, "app.css"), "utf8")}</style></head><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" class="wand-ui-portals" data-wand-ui-root></div>${bootstrap}<script>${inlineScript("plush-avatar.js")}</script><script>${inlineScript("app.js")}</script></body></html>`);
  return `<!doctype html><html lang="zh-CN"><head>${head}<link rel="stylesheet" href="/foundation.css"><link rel="stylesheet" href="/app.css"></head><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" class="wand-ui-portals" data-wand-ui-root></div>${bootstrap}<script src="/app.js"></script></body></html>`;
}

export async function startPreview({ port = 8797, requests = [] } = {}) {
  const html = await buildPreview();
  const files = { "/foundation.css": ["foundation.css", "text/css"], "/app.css": ["app.css", "text/css"], "/app.js": ["app.js", "text/javascript"], "/assets/plush-avatar.js": ["plush-avatar.js", "text/javascript"] };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ method: request.method, pathname });
    response.setHeader("Content-Security-Policy", csp);
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.writeHead(405); response.end("Read-only preview"); return; }
    if (pathname === "/" || pathname === "/index.html") { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(html); return; }
    if (!files[pathname]) { response.writeHead(404); response.end("Not found"); return; }
    response.setHeader("Content-Type", files[pathname][1]); response.end(readFileSync(join(output, files[pathname][0])));
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, requests };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--build")) { await buildPreview(); console.log(join(output, "Wand-scheduled-tasks-preview.html")); }
  else { const preview = await startPreview(); console.log(`Scheduled tasks isolated preview: ${preview.origin}`); }
}
