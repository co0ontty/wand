import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 用 mtime 做缓存键，磁盘上 CSS 一变（npm run build / 手工 edit dist/）下次请求
// 就会自动 re-read。否则进程启动时缓存的 CSS 会粘住整个生命周期，UI 改动看不到效果，
// 必须重启 wand 才能生效——开发 / 修 UI 的时候这点尤其难受。
// 同步 stat 的成本：本地 fs，~几十微秒，相对一次 HTML 渲染可忽略。
let _cssCache = EMBEDDED_WEB_ASSETS.stylesCss;
let _cssCacheMtimeMs = 0;
export function getCSSStyles() {
    const cssPath = path.join(__dirname, "content", "styles.css");
    try {
        const stat = fs.statSync(cssPath);
        if (_cssCache === null || stat.mtimeMs !== _cssCacheMtimeMs) {
            _cssCache = fs.readFileSync(cssPath, "utf-8");
            _cssCacheMtimeMs = stat.mtimeMs;
        }
    }
    catch {
        // Self-update can remove the package directory before the old process exits.
        // Keep serving the embedded build CSS until the process restarts.
    }
    return _cssCache;
}
