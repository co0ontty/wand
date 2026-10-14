import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { coreHarnessAgentDir } from "./harness-engine.js";
import { importPiCliModule, resolvePiCliPackage } from "./pi-cli-runtime.js";
import { cliPiResourceReader, installedPiUserResources } from "./pi-user-resources.js";
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

/** CLI-owned, read-only parser: no connection, credential command, extension code or Wand SDK. */
export async function readUserPiMcpConfig(agentDir: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<McpConfig> {
  const parser = await importPiCliModule<{ loadMcpConfig(options: {
    agentDir: string; cwd: string; projectTrusted: boolean;
  }): McpConfig }>(resolvePiCliPackage(env, cwd), "extensions/mcp/config.js");
  if (typeof parser.loadMcpConfig !== "function") throw new Error("Pi CLI 不支持只读 MCP 配置发现。");
  return parser.loadMcpConfig({ agentDir, cwd, projectTrusted: false });
}

/** Installed USER resources only. No package downloads and no project config mutation/trust elevation. */
export async function discoverPiResources(config: Pick<WandConfig, "harness">, cwd: string,
  env?: NodeJS.ProcessEnv): Promise<PiResourceInventory> {
  const pi = await cliPiResourceReader(cwd, env);
  const agentDir = coreHarnessAgentDir(config.harness);
  const resolved = await installedPiUserResources(pi, agentDir, cwd);
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
  const mcp = await readUserPiMcpConfig(agentDir, cwd, env);
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
