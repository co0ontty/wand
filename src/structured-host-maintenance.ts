import type { DaemonMaintenanceTarget } from "./daemon-maintenance.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { countRunningDaemonEntries } from "./daemon-maintenance-targets.js";

/** Include independently persistent CLI owners in the same maintenance barrier. */
export function structuredHostMaintenance(host: StructuredExecHost): DaemonMaintenanceTarget {
  return {
    name: "structured-executions",
    async inspect(includeInventory = true) {
      const runs = includeInventory ? await host.listRuns() : null;
      return { identity: "structured-executions", pending: false,
        running: runs ? countRunningDaemonEntries(runs) : null };
    },
    async restart() { /* This target guards execution owners; it has no daemon to replace. */ },
    async interrupt() {
      const runs = await host.listRuns();
      for (const run of runs) {
        if (run.status !== "running") continue;
        const process = await host.adoptRun(run.runId);
        if (!process || process.incarnationId !== run.incarnationId) {
          throw new Error("Structured execution ownership changed during maintenance; update postponed");
        }
        process.interrupt();
      }
    },
  };
}
