import { createHash } from "node:crypto";
import { readFile, mkdir, lstat, readlink, writeFile, symlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";

const FILES = ["SKILL.md", "scripts/decide.mjs"] as const;
const sha = (data: string): string => createHash("sha256").update(data).digest("hex");

/** One managed source, three discovery locations; never edits a provider's settings or permissions. */
export async function installDecisionSkill(configDir: string, providers: readonly SessionProvider[] = SESSION_PROVIDERS, home = homedir()): Promise<{ installed: string[]; providers: readonly SessionProvider[] }> {
  if (!providers.length || providers.some((provider) => !SESSION_PROVIDERS.includes(provider))) throw new Error("未知CLI技能目标。");
  const canonical = path.join(configDir, "skills", "wand-decision");
  const source = fileURLToPath(new URL("../skills/wand-decision/", import.meta.url));
  const targets = new Set<string>();
  for (const provider of providers) {
    const directory = provider === "claude" ? ".claude" : provider === "qoder" ? ".qoder" : ".agents";
    targets.add(path.join(home, directory, "skills", "wand-decision"));
  }
  // Preflight every target before touching anything; existing user content is never replaced.
  for (const target of targets) {
    try {
      const info = await lstat(target);
      if (!info.isSymbolicLink() || path.resolve(path.dirname(target), await readlink(target)) !== path.resolve(canonical)) {
        throw new Error(`已有同名技能，保留原内容，请先手动处理：${target}`);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(await readFile(path.join(canonical, ".wand-managed.json"), "utf8")) as Record<string, string>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const contents = await Promise.all(FILES.map(async (file) => ({ file, content: await readFile(path.join(source, file), "utf8") })));
  for (const { file, content } of contents) {
    try {
      const old = await readFile(path.join(canonical, file), "utf8");
      if (old !== content && sha(old) !== previous[file]) throw new Error(`技能已有用户修改，拒绝覆盖：${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await mkdir(path.join(canonical, "scripts"), { recursive: true });
  for (const { file, content } of contents) await writeFile(path.join(canonical, file), content, { mode: 0o644 });
  await writeFile(path.join(canonical, ".wand-managed.json"), JSON.stringify(Object.fromEntries(contents.map(({ file, content }) => [file, sha(content)]))), { mode: 0o600 });
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    try { await symlink(canonical, target, "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await realpath(target) !== await realpath(canonical)) throw new Error("技能链接目标校验失败。");
  }
  return { installed: [...targets], providers };
}
