/**
 * Compiles the Tailwind v4 + Appica UI entry (src/web-ui/css/appica.css) into
 * src/web-ui/content/tailwind.css.
 *
 * The output is a generated artifact consumed by src/web-ui/styles.ts, which
 * appends it after the hand-written content/styles.css. Do not edit the output
 * by hand. Uses the Tailwind CLI so the CSS pipeline matches what Appica
 * documents, instead of relying on unstable @tailwindcss/node internals.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const entry = path.join(root, "src", "web-ui", "css", "appica.css");
const outfile = path.join(root, "src", "web-ui", "content", "tailwind.css");
const cli = path.join(root, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");

const result = spawnSync(process.execPath, [cli, "-i", entry, "-o", outfile], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error("tailwind bundle failed");
  process.exit(result.status ?? 1);
}

console.log(`tailwind bundle written to ${path.relative(root, outfile)}`);
