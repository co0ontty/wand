/** Build only the utilities/preflight still used by Wand's feature layouts.
 * Ant Design/X install their own styles; no Appica CSS or token bridge is loaded.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(tmpdir(), "wand-tailwind-"));
const entry = path.join(temporary, "utilities.css");
const outfile = path.join(root, "src/web-ui/content/tailwind.css");
const cli = path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs");
try {
  writeFileSync(entry, `@import ${JSON.stringify(path.join(root, "node_modules/tailwindcss/index.css"))} source(none);\n@source ${JSON.stringify(path.join(root, "src/web-ui/react"))};\n@source ${JSON.stringify(path.join(root, "src/web-ui/browser"))};\n`);
  const result = spawnSync(process.execPath, [cli, "-i", entry, "-o", outfile, "--minify"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tailwind bundle failed (${result.status})`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(`tailwind utilities written to ${path.relative(root, outfile)}`);
