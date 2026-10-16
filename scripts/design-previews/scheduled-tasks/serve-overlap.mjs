import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const repo = resolve(import.meta.dirname, "../../..");
export const output = join(repo, "output/design-previews/scheduled-tasks/overlap-study");
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
export async function buildStudy() {
  mkdirSync(output, { recursive: true });
  await build({ entryPoints: [join(import.meta.dirname, "overlap-study.tsx")], outfile: join(output, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  await build({ entryPoints: [join(repo, "src/web-ui/react/avatars/renderer.ts")], outfile: join(output, "avatar.js"), bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true });
  const foundation = readFileSync(join(repo, "src/web-ui/content/styles.css"), "utf8");
  writeFileSync(join(output, "foundation.css"), foundation);
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Wand · 重叠日程设计核对</title>`;
  const body = '<div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script>globalThis.__wandBrowserRuntime={plushAvatarChunkSrc:"/avatar.js"};</script>';
  const script = name => readFileSync(join(output, name), "utf8").replace(/<\/script/gi, "<\\/script");
  writeFileSync(join(output, "Wand-calendar-overlap.html"), `<!doctype html><html lang="zh-CN"><head>${head}<style>${foundation}\n${readFileSync(join(output, "app.css"), "utf8")}</style></head><body>${body}<script>${script("avatar.js")}</script><script>${script("app.js")}</script></body></html>`);
  return `<!doctype html><html lang="zh-CN"><head>${head}<link rel="stylesheet" href="/foundation.css"><link rel="stylesheet" href="/app.css"></head><body>${body}<script src="/app.js"></script></body></html>`;
}
export async function startStudy(port = 8798) {
  const html = await buildStudy(), requests = [];
  const files = { "/app.js": "text/javascript", "/app.css": "text/css", "/foundation.css": "text/css", "/avatar.js": "text/javascript" };
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    requests.push({ method: request.method, path });
    response.setHeader("Content-Security-Policy", csp); response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
    if (path === "/") { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(html); return; }
    if (!files[path]) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", files[path]); response.end(readFileSync(join(output, path.slice(1))));
  });
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", ready); });
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--build")) { await buildStudy(); console.log(join(output, "Wand-calendar-overlap.html")); }
  else { const study = await startStudy(); console.log(study.origin); }
}
