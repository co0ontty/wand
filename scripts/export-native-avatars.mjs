// Export the actual Web scene once; native lists do not need a WebView or a GPU context.
// Run with Node, esbuild and Playwright (or WAND_PLAYWRIGHT_MODULE pointing to its module).
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const catsOnly = process.argv.includes("--cats-only");
const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
const bundle = await build({ entryPoints: [path.join(root, "src/web-ui/react/avatars/renderer.ts")], bundle: true, write: false, format: "iife" });
const contract = await build({ entryPoints: [path.join(root, "src/plush-avatar.ts")], bundle: true, write: false, format: "iife", globalName: "contract" });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 192, height: 192 }, deviceScaleFactor: 2 });
  await page.setContent('<canvas style="width:64px;height:64px"></canvas>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.addScriptTag({ content: contract.outputFiles[0].text });
  const configs = await page.evaluate(catsOnly => {
    const c = globalThis.contract;
    const result = [];
    if (!catsOnly) for (const { id: shape } of c.PLUSH_SHAPES) for (const { id: color } of c.PLUSH_COLORS)
      for (const { id: glasses } of c.PLUSH_GLASSES) for (const { id: hat } of c.PLUSH_HATS)
        result.push({ version: 1, shape, color, glasses, hat });
    result.push({ version: 1, kind: "cat", coat: "silver" }, { version: 1, kind: "cat", coat: "orange" });
    return result;
  }, catsOnly);
  const android = path.join(root, "android/app/src/main/assets/plush");
  const ios = path.join(root, "ios/Wand/Assets.xcassets");
  await mkdir(android, { recursive: true });
  let bytes = 0;
  for (const config of configs) {
    const key = "kind" in config ? `plush_cat_${config.coat}` : `plush_${config.shape}_${config.color}_${config.glasses}_${config.hat}`;
    await page.evaluate(config => {
      globalThis.handle?.dispose();
      const canvas = document.querySelector("canvas");
      delete canvas.dataset.frame;
      globalThis.handle = globalThis.__wandPlushRuntime.attach(canvas,
        { config, size: 64, speaking: false, interactive: false, reducedMotion: true }, () => {});
    }, config);
    await page.waitForFunction(() => Number(document.querySelector("canvas").dataset.frame) > 0, { timeout: 30000 });
    // Preserve the Web list model with enough pixels for 3× native titles.
    const data = await page.evaluate(() => document.querySelector("canvas").toDataURL("image/png").split(",")[1]);
    const png = Buffer.from(data, "base64");
    bytes += png.length;
    await writeFile(path.join(android, key + ".png"), png);
    const imageset = path.join(ios, key + ".imageset");
    await mkdir(imageset, { recursive: true });
    await writeFile(path.join(imageset, key + ".png"), png);
    await writeFile(path.join(imageset, "Contents.json"), JSON.stringify({ images: [{ filename: key + ".png", idiom: "universal" }], info: { author: "xcode", version: 1 } }, null, 2) + "\n");
  }
  console.log(JSON.stringify({ exported: configs.length, bytesPerPlatform: bytes, renderer: "src/web-ui/react/avatars/renderer.ts", pixels: 128 }));
} finally { await browser.close(); }
