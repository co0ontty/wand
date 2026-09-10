import { spawnSync } from "node:child_process";

export function signalProcessTree(child, signal) {
  if (process.platform === "win32" && Number.isInteger(child?.pid)) {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }

  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}
