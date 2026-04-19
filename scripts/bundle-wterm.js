import { build } from "esbuild";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src", "web-ui", "content", "vendor", "wterm");

await build({
  entryPoints: [path.join(__dirname, "wterm-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "WTermLib",
  outfile: path.join(outDir, "wterm.bundle.js"),
  minify: true,
  target: ["es2020"],
  platform: "browser",
});

cpSync(
  path.join(root, "node_modules", "@wterm", "dom", "src", "terminal.css"),
  path.join(outDir, "terminal.css"),
);

console.log("wterm bundle built successfully");
