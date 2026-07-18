import { Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeSkillSummary {
  name: string;
  description: string;
  source: "user" | "project";
}

function parseFrontmatter(source: string): { name?: string; description?: string } {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const frontmatter = source.slice(3, end);
  const name = frontmatter.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const description = frontmatter.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return { name, description };
}

function readSkills(directory: string, source: ClaudeSkillSummary["source"]): ClaudeSkillSummary[] {
  if (!existsSync(directory)) return [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const skillFile = path.join(directory, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) return [];
    try {
      const metadata = parseFrontmatter(readFileSync(skillFile, "utf8"));
      return [{
        name: metadata.name || entry.name,
        description: metadata.description || "",
        source,
      }];
    } catch {
      return [];
    }
  });
}

export function listClaudeSkills(cwd: string): ClaudeSkillSummary[] {
  const byName = new Map<string, ClaudeSkillSummary>();
  for (const skill of [
    ...readSkills(path.join(os.homedir(), ".claude", "skills"), "user"),
    ...readSkills(path.join(cwd, ".claude", "skills"), "project"),
  ]) {
    byName.set(skill.name, skill);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
