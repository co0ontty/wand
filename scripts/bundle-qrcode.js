import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "src", "web-ui", "content", "vendor", "qrcode");

await build({
  entryPoints: [path.join(__dirname, "qrcode-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "QRCodeLib",
  // Unwrap the default export so window.QRCodeLib is the QRCode object directly.
  footer: { js: "window.QRCodeLib = QRCodeLib.default || QRCodeLib;" },
  outfile: path.join(outDir, "qrcode.bundle.js"),
  minify: true,
  target: ["es2020"],
  platform: "browser",
});

console.log("qrcode bundle built successfully");
