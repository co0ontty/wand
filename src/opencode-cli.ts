import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { whichSync } from "./path-repair.js";
import { extractSemver } from "./version-utils.js";

const execFileAsync = promisify(execFile);
let cachedVersion: { identity: string; version: Promise<number> } | undefined;

/** Resolve the actual executable; an upgrade invalidates the cached CLI dialect. */
export async function openCodeMajorVersion(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const executable = whichSync("opencode", { env });
  if (!executable) throw new Error("未找到 OpenCode CLI。");
  const stat = statSync(executable);
  const identity = `${executable}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (cachedVersion?.identity !== identity) {
    const version = execFileAsync(executable, ["--version"], { env, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8" })
      .then(({ stdout }) => {
        const parsed = extractSemver(stdout);
        if (!parsed) throw new Error("无法识别 OpenCode CLI 版本。");
        return Number(parsed.split(".")[0]);
      });
    cachedVersion = { identity, version };
    void version.catch(() => { if (cachedVersion?.version === version) cachedVersion = undefined; });
  }
  const major = await cachedVersion.version;
  signal?.throwIfAborted();
  return major;
}

/** v2 returns priced native records through its read-only API, v1 through verbose models. */
export function openCodeCatalogArgs(major: number, nativeFree = false): string[] {
  return major >= 2
    ? ["api", "--standalone", "model.list"]
    : nativeFree ? ["models", "opencode", "--verbose", "--refresh", "--pure"] : ["models", "--verbose"];
}

/** v2 folds the reasoning variant into the model reference. */
export function openCodeModelArgs(model: string | null | undefined, variant: string | null, major: number): string[] {
  const value = model?.trim();
  const args: string[] = [];
  if (value && value !== "default") {
    args.push("--model", major >= 2 && variant ? `${value.split("#")[0]}#${variant}` : value);
  } else if (major >= 2 && variant) {
    throw new Error("OpenCode 2 的思考深度需要具体模型，请先选择模型。");
  }
  if (major < 2 && variant) args.push("--variant", variant);
  return args;
}
