import { readFile } from "node:fs/promises";
import path from "node:path";
import { coreHarnessAgentDir, loadPiCodingAgent } from "./harness-engine.js";
import type { WandConfig } from "./types.js";
import type { PiSessionSettings } from "./pi-session-settings.js";
import type { EventBus, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult, ResourceLoader } from "@earendil-works/pi-coding-agent";

type CodingAgent = Awaited<ReturnType<typeof loadPiCodingAgent>>;

/** Resolve already-installed USER resources only. Never install, import code, or trust project packages. */
export async function installedPiExtensions(config: WandConfig, cwd: string): Promise<Array<{ path: string; name: string; goal: boolean }>> {
  const pi = await loadPiCodingAgent();
  const agentDir = coreHarnessAgentDir(config.harness);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const settings = pi.SettingsManager.inMemory({
    packages: Array.isArray(raw.packages) ? raw.packages : [],
    extensions: Array.isArray(raw.extensions) ? raw.extensions.filter((item): item is string => typeof item === "string") : [],
  }, { projectTrusted: false });
  const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const resolved = await manager.resolve(async () => "skip");
  return resolved.extensions.filter((item) => item.enabled && item.metadata.scope === "user").map((item) => {
    const name = item.metadata.source === "local" || item.metadata.source === "auto"
      ? path.basename(item.path) : item.metadata.source.replace(/^npm:/, "");
    return { path: item.path, name, goal: /(?:^|[/:])pi-goal(?:[/@]|$)/.test(`${item.metadata.source}/${item.path}`) };
  });
}

interface NativeExtensionLoader {
  loadExtensions(paths: string[], cwd: string, events: EventBus, runtime: ExtensionRuntime): Promise<LoadExtensionsResult>;
  loadExtensionFromFactory(factory: ExtensionFactory, cwd: string, events: EventBus, runtime: ExtensionRuntime, name: string): Promise<LoadExtensionsResult["extensions"][number]>;
}

/**
 * The pinned SDK's public ResourceLoader caches imported factories by cwd. Many user extensions
 * (including pi-goal) keep module-level state; sharing those factories leaks across Wand sessions.
 * Use its uncached file loader, at this one version-locked boundary, with explicit installed paths.
 */
async function nativeExtensionLoader(): Promise<NativeExtensionLoader> {
  const url = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loaded = await import(url.href) as NativeExtensionLoader;
  if (typeof loaded.loadExtensions !== "function" || typeof loaded.loadExtensionFromFactory !== "function") {
    throw new Error("当前 Pi SDK 不支持隔离扩展加载；请检查锁定的 SDK 版本。");
  }
  return loaded;
}

export async function createPiExtensionResources(
  pi: CodingAgent, config: WandConfig, cwd: string, settings: PiSessionSettings, systemPrompt: string,
): Promise<ResourceLoader> {
  const resources = settings.globalTools || settings.goalMode ? await installedPiExtensions(config, cwd) : [];
  if (settings.goalMode && !resources.some((item) => item.goal)) {
    throw new Error("目标模式不可用：请先在 Pi 中安装并启用 pi-goal。");
  }
  const paths = resources.filter((item) => item.goal ? settings.goalMode : settings.globalTools).map((item) => item.path);
  const loader = await nativeExtensionLoader();
  const runtime = pi.createExtensionRuntime();
  const events = pi.createEventBus();
  const result = await loader.loadExtensions(paths, cwd, events, runtime);
  if (result.errors.length) throw new Error(`Pi 扩展加载失败：${result.errors.map((item) => `${path.basename(item.path)}: ${item.error}`).join("；")}`);
  if (settings.codemode !== "off") {
    result.extensions.push(await loader.loadExtensionFromFactory(
      // Only orchestration of enabled tools. No implicit classifier/image API access.
      pi.createCodemodeExtension({ mode: settings.codemode, models: false }), cwd, events, runtime, "wand:codemode",
    ));
  }
  return {
    getExtensions: () => result,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => { throw new Error("原生 Pi 扩展按回合加载；请在下一轮重载。"); },
  };
}
