import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export function isClaudeSessionFileAvailable(cwd: string, claudeSessionId: string): boolean {
  const filePath = path.join(getClaudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
  try {
    const lines = readFileSync(filePath, "utf8").split("\n");
    const fileSessionIds = new Set<string>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { sessionId?: string };
        if (parsed.sessionId) fileSessionIds.add(parsed.sessionId);
      } catch {
        continue;
      }
    }
    // Resumed JSONL can contain several session IDs; startup files can have none.
    return fileSessionIds.size === 0 || fileSessionIds.has(claudeSessionId)
      || lines.some((line) => line.includes(`"${claudeSessionId}"`));
  } catch {
    return false;
  }
}

export function getClaudeProjectDir(cwd: string): string {
  // Claude Code encodes the project dir by replacing every non-alphanumeric
  // character (slash, dot, underscore, etc.) with "-", not just "/".
  const normalized = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", normalized);
}
