import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src", "web-ui", "content", "vendor", "xterm");

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [path.join(__dirname, "xterm-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "XTermLib",
  outfile: path.join(outDir, "xterm.bundle.js"),
  minify: true,
  target: ["es2020"],
  platform: "browser",
});

cpSync(
  path.join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  path.join(outDir, "xterm.css"),
);

console.log("xterm bundle built successfully");
