import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 顺序即层叠顺序：Tailwind/Appica 编译产物在前，手写 styles.css 在后。
//
// 两个原因决定这个顺序不能反过来：
//
// 1. Tailwind 的 @layer 规则永远输给无层规则，所以 styles.css 里的手写规则
//    仍然稳压 Utilities 一层（两个文件里 `*` 重置的分工见
//    src/web-ui/css/appica.css 顶部说明）。这一条与先后无关。
// 2. Appica 在自己的无层 `:root` 里也声明了一批与 Wand 同名的 token
//    （--success / --warning / --info / --border-strong / --radius-md /
//    --shadow-sm …）。无层对无层只能靠先后裁决，styles.css 必须排在后面，
//    否则 Appica 的中性灰会悄无声息地覆盖掉整套暖色调。
const CSS_FILES = ["tailwind.css", "styles.css"] as const;

// 用 mtime+size 做缓存键，磁盘上 CSS 一变（npm run build / 手工 edit dist/）下次请求
// 就会自动 re-read。否则进程启动时缓存的 CSS 会粘住整个生命周期，UI 改动看不到效果，
// 必须重启 wand 才能生效——开发 / 修 UI 的时候这点尤其难受。
// 同步 stat 的成本：本地 fs，~几十微秒，相对一次 HTML 渲染可忽略。
let _cssCache: string = EMBEDDED_WEB_ASSETS.stylesCss;
let _cssCacheKey = "";

function cssCacheKey(): string {
  return CSS_FILES.map((name) => {
    const stat = fs.statSync(path.join(__dirname, "content", name));
    return `${name}:${stat.mtimeMs}:${stat.size}`;
  }).join("|");
}

export function getCSSStyles(): string {
  try {
    const key = cssCacheKey();
    if (key !== _cssCacheKey) {
      _cssCache = CSS_FILES.map((name) =>
        fs.readFileSync(path.join(__dirname, "content", name), "utf-8"),
      ).join("\n");
      _cssCacheKey = key;
    }
  } catch {
    // Self-update can remove the package directory before the old process exits.
    // Keep serving the embedded build CSS until the process restarts.
  }
  return _cssCache;
}
