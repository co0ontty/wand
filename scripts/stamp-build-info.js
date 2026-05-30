/**
 * 在 `npm run build` 末尾运行：把构建时的 git commit / 时间 / 版本 / 通道写进
 * dist/build-info.json。
 *
 * 用途：
 *   - server.ts 读它拿到「当前构建源自哪个 commit / 是不是 beta 构建」，
 *     用于 Beta 通道的 commit 比对与 UI 展示；
 *   - beta 分支由 GitHub Actions 构建时设 WAND_BUILD_CHANNEL=beta，stamp 出
 *     channel=beta、commit=master HEAD；正式版（本地 / publish.sh / npm-release CI）
 *     则 channel=stable、commit=release commit。
 *
 * 无 git 环境（极少数）时 commit=null，server 会优雅降级，不报错。
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

function gitCommit() {
  try {
    const out = execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

const channel = process.env.WAND_BUILD_CHANNEL === "beta" ? "beta" : "stable";

const info = {
  commit: gitCommit(),
  builtAt: new Date().toISOString(),
  version: pkgVersion(),
  channel,
};

mkdirSync(distDir, { recursive: true });
writeFileSync(path.join(distDir, "build-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
console.log(`[stamp-build-info] ${JSON.stringify(info)}`);
