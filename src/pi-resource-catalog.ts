import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { coreHarnessAgentDir, loadPiCodingAgent } from "./harness-engine.js";
import type { PiResourceCatalog, PiResourceSelection } from "./pi-session-settings.js";
import type { WandConfig } from "./types.js";
import type { Skill, McpExtensionOptions } from "@earendil-works/pi-coding-agent";

type McpConfig = ReturnType<NonNullable<McpExtensionOptions["loadConfig"]>>;
export interface PiResourceInventory {
  catalog: PiResourceCatalog;
  skills: Map<string, Skill>;
  servers: Map<string, McpConfig["servers"][number]>;
}

function resourceId(kind: "skill" | "mcp", identity: string): string {
  return `${kind}-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

/** Pinned, read-only parser boundary; never connects, runs credential commands or loads extension code. */
export async function readUserPiMcpConfig(agentDir: string, cwd: string): Promise<McpConfig> {
  const url = new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const parser = await import(url.href) as { loadMcpConfig(options: {
    agentDir: string; cwd: string; projectTrusted: boolean;
  }): McpConfig };
  return parser.loadMcpConfig({ agentDir, cwd, projectTrusted: false });
}

/** Installed USER resources only. No package downloads and no project config mutation/trust elevation. */
export async function discoverPiResources(config: Pick<WandConfig, "harness">, cwd: string): Promise<PiResourceInventory> {
  const pi = await loadPiCodingAgent();
  const agentDir = coreHarnessAgentDir(config.harness);
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
  const resolved = await manager.resolve(async () => "skip");
  const paths = resolved.skills.filter((item) => item.enabled && item.metadata.scope === "user").map((item) => item.path);
  const loaded = pi.loadSkills({ cwd, agentDir, skillPaths: paths, includeDefaults: false });
  const skills = new Map<string, Skill>();
  for (const skill of loaded.skills) {
    const canonical = await realpath(skill.filePath);
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 128 * 1024) continue;
    const id = resourceId("skill", canonical);
    if (!skills.has(id)) skills.set(id, { ...skill, filePath: canonical });
    if (skills.size >= 200) break;
  }
  const mcp = await readUserPiMcpConfig(agentDir, cwd);
  const servers = new Map<string, McpConfig["servers"][number]>();
  for (const server of mcp.servers.slice(0, 64)) servers.set(resourceId("mcp", server.name), server);
  const customMcp = resolved.extensions.some((item) => item.enabled && /pi-mcp-adapter/.test(item.metadata.source));
  return { skills, servers, catalog: {
    supported: !customMcp,
    reason: customMcp ? "当前 Pi 使用第三方 MCP 适配器，无法保证只连接选定服务器，请先使用 Pi 内置 MCP。"
      : mcp.errors.length ? "MCP 配置含无效条目，仅列出已验证的服务器；未选条目不会连接。" : "",
    skills: [...skills].map(([id, skill]) => ({ id, name: skill.name,
      description: skill.description.slice(0, 1024), source: "已安装" })),
    mcpServers: [...servers].map(([id, server]) => ({ id, name: server.name,
      description: "url" in server.config ? "已配置的 HTTP MCP 服务" : "已配置的本地 MCP 服务",
      source: server.config.enabled === false ? "全局停用 · 本会话可选" : "用户配置" })),
  } };
}

export function resolvePiResourceSelection(inventory: PiResourceInventory, selection: PiResourceSelection): {
  skills: Skill[]; servers: McpConfig["servers"];
} {
  if (!inventory.catalog.supported) throw new Error(inventory.catalog.reason);
  const skills = selection.skills.map((id) => {
    const found = inventory.skills.get(id);
    if (!found) throw new Error("所选 Skill 已不存在或已被停用，请重新选择；没有改用其他 Skill。");
    return found;
  });
  const servers = selection.mcpServers.map((id) => {
    const found = inventory.servers.get(id);
    if (!found) throw new Error("所选 MCP 已不存在，请重新选择；没有连接其他 MCP。");
    return found;
  });
  return { skills, servers };
}
