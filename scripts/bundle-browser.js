import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

buildSync({
  entryPoints: [path.join(root, "src", "web-ui", "browser", "main.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(root, "src", "web-ui", "content", "scripts.js"),
  minify: false,
  treeShaking: false,
  target: ["es2017"],
  platform: "browser",
});

console.log("browser scripts bundled successfully");
