import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// Standalone installation has no Wand runtime to import yet. The checked target
// is passed as a concrete version to npm; dist-tags cannot move underneath it.
export function selectBootstrapUpdateVersion(tags, channel) {
  if (channel !== "stable" && channel !== "beta") throw new Error("更新通道必须为 stable 或 beta。");
  const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const betaPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/;
  const stable = typeof tags.latest === "string" && stablePattern.test(tags.latest) ? tags.latest : null;
  const beta = typeof tags.beta === "string" && betaPattern.test(tags.beta) ? tags.beta : null;
  function newer(left, right) {
    const a = left.split("-")[0].split(".").map(Number);
    const b = right.split("-")[0].split(".").map(Number);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    // Local debug builds represent source after the same stable tag.
    const debugA = left.split("-")[1]?.startsWith("debug");
    const debugB = right.split("-")[1]?.startsWith("debug");
    if (!!debugA !== !!debugB) return !!debugA;
    return !left.includes("-") && right.includes("-");
  }
  const version = channel === "beta" && beta && (!stable || newer(beta, stable)) ? beta : stable;
  if (!version) throw new Error("所选更新通道没有有效版本，当前安装未修改。");
  return version;
}

let main = false;
try { main = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported module */ }
if (main) {
  try {
    console.log(selectBootstrapUpdateVersion(JSON.parse(process.argv[3]), process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
