import { readFileSync } from "node:fs";

/**
 * The pinned baseline in .nvmrc. CI, publishes and the bundle-budget numbers
 * are measured on exactly this release. Runtime support is defined separately
 * by package.json engines, not by this reproducibility pin.
 */
export const nodeBaseline = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const nodeMinimum = manifest.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
if (!nodeMinimum) throw new Error("Expected a minimum Node version in package.json engines.node.");

/** Numeric major.minor.patch comparison; missing parts count as 0. */
export function compareNodeVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const have = a[i] ?? 0;
    const need = b[i] ?? 0;
    if (have > need) return 1;
    if (have < need) return -1;
  }
  return 0;
}
