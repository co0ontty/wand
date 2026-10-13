import os from "node:os";
import path from "node:path";
import { runCommandSync } from "../run-command.js";
import type { ServiceManager, ServiceScope } from "./index.js";

export class LaunchdServiceManager implements ServiceManager {
  readonly platform = "darwin" as const;

  unitPath(scope: ServiceScope): string {
    return scope === "user"
      ? path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist")
      : "/Library/LaunchDaemons/com.wand.web.plist";
  }

  readEntrypoint(scope: ServiceScope): string | null {
    const result = runCommandSync("plutil", ["-extract", "ProgramArguments.1", "raw", "-o", "-", this.unitPath(scope)],
      { timeout: 5_000 });
    return result.status === 0 ? (result.stdout || "").trim() || null : null;
  }
}

/** PID of the loaded com.wand.web job in a launchd domain ("system" or "gui/<uid>"), or null. */
export function launchdMainPid(domain: string, label = "com.wand.web"): number | null {
  const result = runCommandSync("launchctl", ["print", `${domain}/${label}`], { timeout: 5_000 });
  if (result.status !== 0) return null;
  const match = (result.stdout || "").match(/(?:^|\n)\s*pid = (\d+)\s*(?:\n|$)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

