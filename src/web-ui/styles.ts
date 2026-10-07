import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WEB_ASSETS } from "./embedded-assets.js";
import { versionWebAsset, type VersionedWebAsset } from "./asset-version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tailwind utilities/preflight precede the retained business CSS. Ant Design/X
// install their own component styles through the shared provider.
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

let _stylesAsset: VersionedWebAsset | null = null;
const embeddedStylesAsset = versionWebAsset(EMBEDDED_WEB_ASSETS.stylesCss);

export function getStylesAsset(requestedHash?: string): VersionedWebAsset {
  const content = getCSSStyles();
  if (!_stylesAsset || _stylesAsset.content !== content) {
    _stylesAsset = versionWebAsset(content);
  }
  if (requestedHash === embeddedStylesAsset.hash) return embeddedStylesAsset;
  return _stylesAsset;
}
