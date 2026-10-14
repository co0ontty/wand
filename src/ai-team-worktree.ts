import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runGit } from "./git-utils.js";
import { AI_TEAM_REPORT_DIR } from "./ai-team-prompts.js";

/** Add .wand-team/ to the shared repository exclusion file when the cwd is in a Git worktree. */
export function excludeAiTeamReportDir(cwd: string): void {
  try {
    const gitDir = runGit(["rev-parse", "--git-common-dir"], cwd);
    if (!gitDir) return;
    const excludeFile = path.join(path.resolve(cwd, gitDir), "info", "exclude");
    const line = `/${AI_TEAM_REPORT_DIR}/`;
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split(/\r?\n/).some((entry) => entry.trim() === line)) return;
    appendFileSync(excludeFile, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
  } catch {
    // Not in a Git repository or no write access: skipping this is non-fatal.
  }
}
