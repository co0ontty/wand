import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runtime dependencies with lifecycle scripts in package-lock.json. This is a
// per-install policy, never a write to the user's npm configuration.
const RUNTIME_SCRIPT_PACKAGES = ["node-pty", "esbuild", "@google/genai", "protobufjs"];

export function npmInstallScriptArgs(npm: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const result = spawnSync(npm, ["config", "get", "allow-scripts"], {
    encoding: "utf8", env, timeout: 5000, maxBuffer: 64 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) throw new Error("无法读取 npm 安装脚本策略，安装未开始。");
  // Older npm releases return "undefined" for unknown config keys. Do not pass
  // unsupported flags, and do not override ignore-scripts if the user set it.
  return result.stdout.trim() === "undefined" ? [] : [`--allow-scripts=${RUNTIME_SCRIPT_PACKAGES.join(",")}`];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const npm = process.argv[2];
    if (!npm || process.argv.length !== 3) throw new Error("需要 npm 可执行文件路径。");
    process.stdout.write(npmInstallScriptArgs(npm).join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
