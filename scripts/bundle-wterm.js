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

// The wterm input handler creates an off-screen <textarea> for keystroke
// capture and marks it with aria-hidden="true". When the terminal is focused
// the browser warns about a focused element living under an aria-hidden
// ancestor. Replace the attribute with a screen-reader label instead.
const fixTextareaAriaPlugin = {
  name: "fix-textarea-aria",
  setup(b) {
    b.onLoad({ filter: /input\.js$/ }, (args) => {
      const original = readFileSync(args.path, "utf8");
      const contents = original.replace(
        /this\.textarea\.setAttribute\("aria-hidden",\s*"true"\);/,
        'this.textarea.setAttribute("aria-label", "terminal input");'
      );
      if (contents === original) {
        console.warn("WARNING: fix-textarea-aria plugin did not match input.js");
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
  plugins: [stripUnderlinePlugin, fixTextareaAriaPlugin],
});

cpSync(
  path.join(root, "node_modules", "@wterm", "dom", "src", "terminal.css"),
  path.join(outDir, "terminal.css"),
);

console.log("wterm bundle built successfully");
