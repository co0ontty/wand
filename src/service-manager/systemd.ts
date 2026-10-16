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

  readConfigPath(scope: ServiceScope): string | null {
    try {
      const execStart = readFileSync(this.unitPath(scope), "utf8").split("\n").find((line) => line.startsWith("ExecStart="));
      const match = execStart?.match(/(?:^|\s)(?:-c|--config)(?:=|\s+)(?:"([^"\\]+)"|'([^'\\]+)'|([^\s"'\\]+))(?=\s|$)/);
      const config = match?.[1] ?? match?.[2] ?? match?.[3];
      return config ? path.resolve(config) : null;
    } catch { return null; }
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
