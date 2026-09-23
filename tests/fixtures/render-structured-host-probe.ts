import process from "node:process";

import { createUpgradeAwareTerminalHost } from "../../src/render-host.js";
import { runTerminalDaemon } from "../../src/terminal-daemon-server.js";

const [mode, configPath, binaryPath, runId] = process.argv.slice(2);

if (mode === "terminald") {
  const configIndex = process.argv.indexOf("-c");
  await runTerminalDaemon(process.argv[configIndex + 1]);
} else if (configPath && binaryPath && runId) {
  const hosts = await createUpgradeAwareTerminalHost(configPath, { engine: "rust", binaryPath });
  try {
    const daemon = hosts.legacyHost;
    if (!daemon || !hosts.renderHost) throw new Error("Render and terminald must both be available");
    if (mode === "start") {
      const run = await daemon.spawnStructured({
        runId,
        file: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
        cwd: process.cwd(),
        env: {},
      });
      process.stdout.write(JSON.stringify({ persistent: daemon.persistent, pid: run.pid }) + "\n");
    } else if (mode === "adopt") {
      const run = await daemon.adoptRun(runId);
      process.stdout.write(JSON.stringify({ persistent: daemon.persistent, pid: run?.pid ?? null }) + "\n");
      run?.interrupt();
    } else {
      throw new Error(`Unknown probe mode: ${mode}`);
    }
  } finally {
    hosts.host.disconnect();
  }
} else {
  throw new Error("Expected a probe mode, config path, binary path, and run ID");
}
