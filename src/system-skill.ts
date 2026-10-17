import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installManagedSkill } from "./managed-skill.js";
import { SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";

export async function installSystemSkill(configPath: string, providers: readonly SessionProvider[] = SESSION_PROVIDERS, home = homedir()) {
  const source = fileURLToPath(new URL("../skills/wand-system/", import.meta.url));
  const files = Object.fromEntries(await Promise.all(["SKILL.md", "references/operations.md", "scripts/wand.mjs", "scripts/web-login.mjs"].map(async file =>
    [file, await readFile(path.join(source, file), "utf8")])));
  const js = fileURLToPath(new URL("./cli.js", import.meta.url));
  const cli = existsSync(js) ? js : js.replace(/\.js$/, ".ts");
  // Only local executable/config paths, never an admin password or capability token.
  files[".runtime.json"] = JSON.stringify({
    node: process.execPath, cli, config: path.resolve(configPath),
    ...(cli.endsWith(".ts") ? { loader: import.meta.resolve("tsx") } : {}),
  });
  return installManagedSkill(path.dirname(configPath), "wand-system", files, providers, home);
}
