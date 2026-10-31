import path from "node:path";
import { createTerminalHost, TerminalDaemonClient } from "./terminal-daemon-client.js";
import type { TerminalHost, TerminalSpawnRequest } from "./terminal-host.js";
import { probeTmuxSupport, tmuxEnabled } from "./tmux-policy.js";
import type { DaemonMaintenanceTarget } from "./daemon-maintenance.js";
import { logInfo } from "./runtime-log.js";

/** Existing owners win even after changing the policy; unknown inventory fails closed. */
export async function createTmuxTerminalHost(
  configPath: string,
  previous: TerminalHost,
  createHost: typeof createTerminalHost = createTerminalHost,
): Promise<{
  host: TerminalHost; client: TerminalDaemonClient | null; configPath: string;
  maintenanceTarget?: DaemonMaintenanceTarget;
}> {
  const daemonConfig = path.join(path.dirname(configPath), "tmux-terminald.json");
  const enabled = tmuxEnabled();
  const probe = enabled ? probeTmuxSupport() : { ok: true };
  const { existsSync } = await import("node:fs");
  if (!enabled && !existsSync(path.join(path.dirname(configPath), "pty-tmux"))) {
    return { host: previous, client: null, configPath: daemonConfig };
  }
  let tmux: TerminalHost;
  try {
    if (!probe.ok) throw new Error(probe.error);
    tmux = await createHost(daemonConfig, { persistent: true });
  }
  catch (cause) {
    const unavailable = () => new Error("tmux terminal ownership is unavailable; refusing execution or maintenance", { cause });
    logInfo(`tmux terminal backend unavailable${probe.error ? `: ${probe.error}` : ""}; existing other owners remain accessible, new PTY execution is blocked`);
    return {
      configPath: daemonConfig,
      client: null,
      maintenanceTarget: {
        name: "tmux-terminald",
        async inspect() { throw unavailable(); },
        async restart() { throw unavailable(); },
        async interrupt() { throw unavailable(); },
      },
      host: {
        persistent: true,
        attach(id, seq) {
          const old = previous.attach(id, seq);
          if (old) return old;
          throw unavailable();
        },
        async createOrAttach(request, seq) {
          const old = previous.attach(request.sessionId, seq);
          if (old) return old;
          throw unavailable();
        },
        forget(id) {
          if (!previous.attach(id)) throw unavailable();
          previous.forget(id);
        },
        flush() { previous.flush?.(); },
        disconnect() { previous.disconnect(); },
      },
    };
  }
  const owner = (id: string): TerminalHost | null => {
    const old = previous.attach(id);
    const current = tmux.attach(id);
    if (old && current) throw new Error("Conflicting terminal owners; refusing duplicate execution");
    return old ? previous : current ? tmux : null;
  };
  return {
    configPath: daemonConfig,
    client: tmux instanceof TerminalDaemonClient ? tmux : null,
    host: {
      persistent: true,
      attach(id, seq) { return owner(id)?.attach(id, seq) ?? null; },
      createOrAttach(request: TerminalSpawnRequest, seq) {
        return (owner(request.sessionId) ?? (enabled ? tmux : previous)).createOrAttach(request, seq);
      },
      forget(id) { owner(id)?.forget(id); },
      flush() { previous.flush?.(); tmux.flush?.(); },
      disconnect() { previous.disconnect(); tmux.disconnect(); },
    },
  };
}
