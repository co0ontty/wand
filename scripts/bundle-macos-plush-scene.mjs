import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Keep the native setScene/disposeScene bridge and CSP unchanged. Replace only
// the generated renderer script, so Web and the offline Mac scene share its fix.
const root = fileURLToPath(new URL("../", import.meta.url));
const scenePath = path.join(root, "macos/Wand/PlushScene/scene.html");
const manifestPath = path.join(root, "macos/Wand/PlushScene/source-hashes.json");
const scene = await readFile(scenePath, "utf8");
const start = scene.indexOf("<script>");
const end = scene.indexOf("</script>", start);
if (start < 0 || end < 0 || !scene.slice(end).includes("window.setScene=")) {
  throw new Error("Unknown macOS scene wrapper; refusing to replace the native bridge");
}
const renderer = await build({ entryPoints: [path.join(root, "src/web-ui/react/avatars/renderer.ts")],
  bundle: true, write: false, format: "iife", minify: true });
const runtime = renderer.outputFiles[0].text;
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
for (const source of Object.keys(manifest.sources)) {
  manifest.sources[source] = createHash("sha256").update(await readFile(path.join(root, source))).digest("hex");
}
manifest.runtimeBytes = Buffer.byteLength(runtime);
await writeFile(scenePath, scene.slice(0, start + "<script>".length) + runtime + scene.slice(end));
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`macOS plush scene regenerated (${manifest.runtimeBytes} renderer bytes)`);
