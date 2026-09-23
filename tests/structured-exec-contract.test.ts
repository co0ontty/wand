import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";
import { TerminalDaemonClient } from "../src/terminal-daemon-client.js";
import {
  assertStructuredContractEquivalent,
  captureStructuredExecContract,
  EXPECTED_STRUCTURED_CONTRACT,
  type ContractSnapshot,
} from "./helpers/structured-exec-contract.js";

test("S0: legacy terminald satisfies the shared structured process contract", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-structured-contract-"));
  const configPath = path.join(root, "config.json");
  const paths = terminalDaemonPaths(configPath);
  const daemon = spawn(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "terminald", "-c", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let daemonStderr = "";
  daemon.stderr?.on("data", (chunk: Buffer) => { daemonStderr += chunk.toString(); });
  t.after(async () => {
    await stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  });

  let token: string | null = null;
  for (let i = 0; i < 100; i++) {
    try { token = readFileSync(paths.tokenPath, "utf8").trim(); break; }
    catch { await delay(50); }
  }
  assert.ok(token, `terminald did not start: ${daemonStderr}`);
  const connect = async (): Promise<TerminalDaemonClient> => {
    const client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    return client;
  };
  const actual = await captureStructuredExecContract(connect, root);
  assertStructuredContractEquivalent(EXPECTED_STRUCTURED_CONTRACT, actual);
});

test("S0: differential assertion rejects a changed semantic field", () => {
  const altered: ContractSnapshot = {
    ...EXPECTED_STRUCTURED_CONTRACT,
    fast: { ...EXPECTED_STRUCTURED_CONTRACT.fast, exitCode: 0 },
  };
  assert.throws(() => assertStructuredContractEquivalent(EXPECTED_STRUCTURED_CONTRACT, altered), assert.AssertionError);
});

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }),
  ]);
}
