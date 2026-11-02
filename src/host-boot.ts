import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

interface HostBoot { id: string; startedAt: number; }
let cachedBoot: HostBoot | null | undefined;

/** Kernel boot identity survives Server restarts, but never a machine restart. */
function hostBoot(): HostBoot | null {
  if (cachedBoot !== undefined) return cachedBoot;
  cachedBoot = null;
  try {
    let id: string;
    let seconds: number;
    if (process.platform === "darwin") {
      const result = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid", "kern.boottime"],
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      id = result.split("\n")[0]!.trim();
      seconds = Number(/\bsec\s*=\s*(\d+)/.exec(result)?.[1]);
    } else if (process.platform === "linux") {
      id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      seconds = Number(/^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    } else return null;
    if (/^[a-f0-9-]{36}$/i.test(id) && Number.isFinite(seconds) && seconds > 0) {
      cachedBoot = { id, startedAt: seconds * 1000 };
    }
  } catch { /* Unknown boot identity must retain the execution ownership barrier. */ }
  return cachedBoot;
}

export function hostBootId(): string | undefined { return hostBoot()?.id; }

export function belongsToPreviousHostBoot(record: { hostBootId?: string; state: string }): boolean {
  const boot = hostBoot();
  if (!boot) return false;
  if (record.hostBootId) return record.hostBootId !== boot.id;
  // Legacy records predate boot IDs. A state file last written before this
  // kernel started cannot own a current process, even if its PID was reused.
  return statSync(record.state).mtimeMs < boot.startedAt - 1000;
}
