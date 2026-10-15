import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installManagedSkill } from "./managed-skill.js";
import { SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";

export async function installDecisionSkill(configDir: string, providers: readonly SessionProvider[] = SESSION_PROVIDERS, home = homedir()): Promise<{ installed: string[]; providers: readonly SessionProvider[] }> {
  const source = fileURLToPath(new URL("../skills/wand-decision/", import.meta.url));
  const files = Object.fromEntries(await Promise.all(["SKILL.md", "scripts/decide.mjs"].map(async file =>
    [file, await readFile(path.join(source, file), "utf8")])));
  return installManagedSkill(configDir, "wand-decision", files, providers, home);
}
