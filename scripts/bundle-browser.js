import { buildSync } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isProduction = !process.argv.includes("--development");

buildSync({
  entryPoints: [path.join(root, "src", "web-ui", "browser", "main.ts")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  outfile: path.join(root, "src", "web-ui", "content", "scripts.js"),
  minify: false,
  treeShaking: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
  },
  target: ["es2020"],
  platform: "browser",
});

console.log(`browser scripts bundled successfully (${isProduction ? "production" : "development"})`);
