import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src", "web-ui", "content", "vendor", "xterm");

mkdirSync(outDir, { recursive: true });
// target 必须 ≥ es2021：@xterm/xterm@6.0.0 发布的是预压缩 ESM（xtermjs/xterm.js#5800），
// esbuild 在 es2020 目标下会把 requestMode 里的 `let r; (r ||= {})` 降级展开成
// 丢失声明的 `void 0 || (i = {})`，运行时解析 DECRQM 查询（CSI ? Ps $ p，opencode/
// vim 等 TUI 启动即发送）就抛 ReferenceError，写循环卡死、终端冻结。
await build({
  entryPoints: [path.join(__dirname, "xterm-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "XTermLib",
  outfile: path.join(outDir, "xterm.bundle.js"),
  minify: true,
  target: ["es2021"],
  platform: "browser",
});

cpSync(
  path.join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  path.join(outDir, "xterm.css"),
);

console.log("xterm bundle built successfully");
