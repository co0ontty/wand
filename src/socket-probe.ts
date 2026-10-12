import net from "node:net";

/** Read-only liveness probe; no authentication or daemon replacement. */
export function probeUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), 300);
    timer.unref?.();
  });
}
