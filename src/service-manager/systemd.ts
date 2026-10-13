import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServiceManager, ServiceScope } from "./index.js";

export class SystemdServiceManager implements ServiceManager {
  readonly platform = "linux" as const;

  unitPath(scope: ServiceScope): string {
    return scope === "user"
      ? path.join(os.homedir(), ".config/systemd/user/wand.service")
      : "/etc/systemd/system/wand.service";
  }

  readEntrypoint(scope: ServiceScope): string | null {
    try {
      const execStart = readFileSync(this.unitPath(scope), "utf8").split("\n").find((line) => line.startsWith("ExecStart="));
      if (!execStart) return null;
      return execStart.slice("ExecStart=".length).trim().split(/\s+/)[1] || null;
    } catch {
      return null;
    }
  }
}
