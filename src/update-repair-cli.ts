import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./env-utils.js";

/** Runs the shipped recovery entry without depending on GitHub availability. */
export async function repairInstalledUpdate(configPath: string): Promise<number> {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/recover-web-update.sh");
  if (!existsSync(script)) throw new Error("当前安装未包含恢复入口，请执行 README 的 install.sh。");
  const env = { ...buildChildEnv(true), WAND_CONFIG_PATH: path.resolve(configPath) };
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [script], { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}
