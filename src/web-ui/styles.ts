import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache the CSS content
let _cssCache: string | null = null;

export function getCSSStyles(): string {
  if (!_cssCache) {
    const cssPath = path.join(__dirname, "content", "styles.css");
    _cssCache = fs.readFileSync(cssPath, "utf-8");
  }
  return _cssCache;
}