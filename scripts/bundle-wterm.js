import { build } from "esbuild";
import { cpSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src", "web-ui", "content", "vendor", "wterm");

const stripUnderlinePlugin = {
  name: "strip-underline",
  setup(b) {
    b.onLoad({ filter: /renderer\.js$/ }, (args) => {
      const original = readFileSync(args.path, "utf8");
      const contents = original.replace(
        /if\s*\(flags\s*&\s*FLAG_UNDERLINE\)\s*\n?\s*decorations\.push\("underline"\);/,
        "/* underline stripped by bundle-wterm */"
      );
      if (contents === original) {
        console.warn("WARNING: strip-underline plugin did not match renderer.js");
      }
      return { contents, loader: "js" };
    });
  },
};

await build({
  entryPoints: [path.join(__dirname, "wterm-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "WTermLib",
  outfile: path.join(outDir, "wterm.bundle.js"),
  minify: true,
  target: ["es2020"],
  platform: "browser",
  plugins: [stripUnderlinePlugin],
});

cpSync(
  path.join(root, "node_modules", "@wterm", "dom", "src", "terminal.css"),
  path.join(outDir, "terminal.css"),
);

console.log("wterm bundle built successfully");
