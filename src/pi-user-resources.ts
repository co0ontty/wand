import { readFile } from "node:fs/promises";
import path from "node:path";
import { importPiCliModule, resolvePiCliPackage } from "./pi-cli-runtime.js";

export type PiResourceReader = Pick<typeof import("@earendil-works/pi-coding-agent"),
  "SettingsManager" | "DefaultPackageManager" | "loadSkills">;

/** CLI inventory imports only the executing CLI's read-only resource modules, never the Wand SDK. */
export async function cliPiResourceReader(cwd: string, env?: NodeJS.ProcessEnv): Promise<PiResourceReader> {
  const root = resolvePiCliPackage(env, cwd);
  const [settings, packages, skills] = await Promise.all([
    importPiCliModule<Pick<PiResourceReader, "SettingsManager">>(root, "core/settings-manager.js"),
    importPiCliModule<Pick<PiResourceReader, "DefaultPackageManager">>(root, "core/package-manager.js"),
    importPiCliModule<Pick<PiResourceReader, "loadSkills">>(root, "core/skills.js"),
  ]);
  if (typeof settings.SettingsManager?.inMemory !== "function" || typeof packages.DefaultPackageManager !== "function"
    || typeof skills.loadSkills !== "function") throw new Error("Pi CLI 不支持只读资源发现；没有加载 Wand SDK。");
  return { ...settings, ...packages, ...skills };
}

/** Resolve installed USER resources only: no download, extension import or project trust elevation. */
export async function installedPiUserResources(pi: PiResourceReader, agentDir: string, cwd: string) {
  let raw: Record<string, unknown> = {};
  try {
    const content = await readFile(path.join(agentDir, "settings.json"), "utf8");
    if (content.length > 1_048_576) throw new Error("配置过大");
    raw = JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Pi 资源配置无法读取，请检查 settings.json。");
  }
  const settings = pi.SettingsManager.inMemory({
    packages: Array.isArray(raw.packages) ? raw.packages : [],
    skills: Array.isArray(raw.skills) ? raw.skills.filter((item): item is string => typeof item === "string") : [],
    extensions: Array.isArray(raw.extensions) ? raw.extensions.filter((item): item is string => typeof item === "string") : [],
  }, { projectTrusted: false });
  const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  return await manager.resolve(async () => "skip");
}
