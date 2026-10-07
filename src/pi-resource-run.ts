import { existsSync, mkdtempSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPiResources, resolvePiResourceSelection } from "./pi-resource-catalog.js";
import type { PiResourceSelection } from "./pi-session-settings.js";

export interface PreparedPiResources {
  args: string[];
  env: NodeJS.ProcessEnv;
  close(): void;
}

/** Re-resolve at execution time: removed resources fail, never silently enable defaults. */
export async function preparePiResources(agentDir: string, cwd: string, selection: PiResourceSelection | undefined,
  baseEnv: NodeJS.ProcessEnv, codemodeOverride?: "off" | "on" | "only"): Promise<PreparedPiResources> {
  const selected = selection ? resolvePiResourceSelection(
    await discoverPiResources({ harness: { engine: "cli", agentDir } }, cwd), selection) : undefined;
  const privateDir = mkdtempSync(path.join(os.tmpdir(), "wand-pi-resources-"));
  chmodSync(privateDir, 0o700);
  try {
    const file = path.join(privateDir, "selection.json");
    writeFileSync(file, JSON.stringify({ agentDir, codemodeOverride,
      ...(selected ? { mcpServers: selected.servers.map((server) => server.name) } : {}) }), { mode: 0o600 });
    const js = fileURLToPath(new URL("./pi-resource-bridge.js", import.meta.url));
    const bridge = existsSync(js) ? js : js.replace(/\.js$/, ".ts");
    return {
      args: [...(selected ? ["--no-skills", ...selected.skills.flatMap((skill) => ["--skill", skill.filePath])] : []),
        "--extension", bridge],
      env: { ...baseEnv, WAND_PI_RESOURCE_POLICY: file },
      close: () => rmSync(privateDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(privateDir, { recursive: true, force: true });
    throw error;
  }
}
