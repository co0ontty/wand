import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { buildChildEnv } from "./env-utils.js";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const UNSUPPORTED = "当前 Pi CLI 无法提供会话级资源接口；请使用官方 npm 或 managed 安装。没有加载 Wand SDK 或改用其他 CLI。";

/** Identify the package owning an actual CLI entry, never resolve from Wand's node_modules. */
function packageOfEntry(entry: string): string | null {
  let actual: string;
  try { actual = realpathSync(entry); } catch { return null; }
  let dir = path.dirname(actual);
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifestPath = path.join(dir, "package.json");
      if (statSync(manifestPath).size > 128 * 1024) throw new Error("manifest too large");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
      if (manifest.name === PACKAGE_NAME && typeof bin === "string"
        && realpathSync(path.resolve(dir, bin)) === actual) return dir;
    } catch { /* Not a package-owned CLI entry. */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Extension code uses the running host, including a CLI update between preparation and spawn. */
export function runningPiCliPackage(): string {
  const root = process.argv[1] && packageOfEntry(process.argv[1]);
  if (!root) throw new Error(UNSUPPORTED);
  return root;
}

/** Read-only npm/managed CLI discovery using the same environment as the actual child. */
export function resolvePiCliPackage(env: NodeJS.ProcessEnv = buildChildEnv(true), cwd = process.cwd()): string {
  const names = process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.resolve(cwd, directory || ".", name);
      try { accessSync(candidate, constants.X_OK); } catch { continue; }
      const direct = packageOfEntry(candidate);
      if (direct) return direct;
      // Official managed launcher: inspect its own active release. Do not evaluate
      // arbitrary shell wrappers or pick a different install later on PATH.
      try {
        const launcher = realpathSync(candidate);
        const install = path.resolve(path.dirname(launcher), "../install");
        const versionFile = path.join(install, "current-version");
        if (statSync(launcher).size > 64 * 1024 || statSync(versionFile).size > 256) throw new Error("unsupported launcher");
        const source = readFileSync(launcher, "utf8");
        const version = readFileSync(versionFile, "utf8").trim();
        if (source.includes("PI_MANAGED_INSTALL_ROOT") && source.includes("install/current-version")
          && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(version)) {
          const managed = packageOfEntry(path.join(install, "releases", version, "node_modules/.bin/pi"));
          if (managed) return managed;
        }
      } catch { /* Unsupported launcher; fail closed. */ }
      throw new Error(UNSUPPORTED);
    }
  }
  throw new Error("未找到 Pi CLI；请先安装 Pi。没有加载 Wand SDK。");
}

/** Resolve a host-provided leaf API against the running CLI, never against the extension's Wand package. */
export async function importPiCliAiModule<T>(root: string, relative: string): Promise<T> {
  try {
    const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(root, "package.json")));
    if (!manifest) throw new Error("CLI peer missing");
    return await import(pathToFileURL(path.join(path.dirname(manifest), "dist", relative)).href) as T;
  } catch { throw new Error("Pi CLI 的 provider 接口加载失败，请检查 CLI 安装。没有改用 Wand SDK。"); }
}

/** One compatibility boundary for CLI-owned built-ins/read-only parsers, not the SDK entry/harness. */
export async function importPiCliModule<T>(root: string, relative: string): Promise<T> {
  const file = path.join(root, "dist", relative);
  if (!existsSync(file)) throw new Error(UNSUPPORTED);
  try { return await import(pathToFileURL(file).href) as T; }
  catch { throw new Error("Pi CLI 的会话级资源接口加载失败，请检查 CLI 安装。没有改用 Wand SDK。"); }
}
