import { createHash } from "node:crypto";
import { readFile, mkdir, lstat, readlink, writeFile, symlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SESSION_PROVIDERS, type SessionProvider } from "./provider-catalog.js";

const sha = (data: string): string => createHash("sha256").update(data).digest("hex");

/** Install trusted bundled files without overwriting user content or changing tool permissions. */
export async function installManagedSkill(configDir: string, name: string, files: Record<string, string>, providers: readonly SessionProvider[] = SESSION_PROVIDERS, home = homedir()): Promise<{ installed: string[]; providers: readonly SessionProvider[] }> {
  if (!providers.length || providers.some((provider) => !SESSION_PROVIDERS.includes(provider))) throw new Error("未知CLI技能目标。");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || Object.keys(files).some(file =>
    path.isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === ".." || part === "."))) {
    throw new Error("无效的托管技能路径。");
  }
  const canonical = path.join(configDir, "skills", name);
  const targets = new Set<string>();
  for (const provider of providers) {
    const directory = provider === "claude" ? ".claude" : provider === "qoder" ? ".qoder" : ".agents";
    targets.add(path.join(home, directory, "skills", name));
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
  const directories = new Set([canonical]);
  for (const file of Object.keys(files)) {
    let directory = path.dirname(path.join(canonical, file));
    while (directory !== canonical) { directories.add(directory); directory = path.dirname(directory); }
  }
  for (const directory of directories) {
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error(`技能目录不是普通目录，保留原内容：${directory}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const file of [...Object.keys(files), ".wand-managed.json"]) {
    try {
      if (!(await lstat(path.join(canonical, file))).isFile()) throw new Error(`技能文件不是普通文件，保留原内容：${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(await readFile(path.join(canonical, ".wand-managed.json"), "utf8")) as Record<string, string>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const contents = Object.entries(files).map(([file, content]) => ({ file, content }));
  for (const { file, content } of contents) {
    try {
      const old = await readFile(path.join(canonical, file), "utf8");
      if (old !== content && sha(old) !== previous[file]) throw new Error(`技能已有用户修改，拒绝覆盖：${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const { file, content } of contents) {
    await mkdir(path.dirname(path.join(canonical, file)), { recursive: true });
    await writeFile(path.join(canonical, file), content, { mode: 0o644 });
  }
  await writeFile(path.join(canonical, ".wand-managed.json"), JSON.stringify(Object.fromEntries(contents.map(({ file, content }) => [file, sha(content)]))), { mode: 0o600 });
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    try { await symlink(canonical, target, "dir"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (await realpath(target) !== await realpath(canonical)) throw new Error("技能链接目标校验失败。");
  }
  return { installed: [...targets], providers };
}
