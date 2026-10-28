import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installManagedSkill } from "./managed-skill.js";
import { SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";

export async function installKnowledgeSkill(configPath: string, providers: readonly SessionProvider[] = SESSION_PROVIDERS, home = homedir()) {
  const source = fileURLToPath(new URL("../skills/wand-knowledge/", import.meta.url));
  const files = Object.fromEntries(await Promise.all(["SKILL.md", "scripts/knowledge.mjs"].map(async file =>
    [file, await readFile(path.join(source, file), "utf8")])));
  const js = fileURLToPath(new URL("./cli.js", import.meta.url));
  const cli = existsSync(js) ? js : js.replace(/\.js$/, ".ts");
  // Local executable paths only; runtime authority is supplied solely by the executing session.
  files[".runtime.json"] = JSON.stringify({ node: process.execPath, cli,
    ...(cli.endsWith(".ts") ? { loader: import.meta.resolve("tsx") } : {}) });
  return installManagedSkill(path.dirname(configPath), "wand-knowledge", files, providers, home);
}
