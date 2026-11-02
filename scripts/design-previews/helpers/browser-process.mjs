// Fixture harness owns one headless Chrome per run: loopback CDP only, throwaway profile, no model calls.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pause = ms => new Promise(done => setTimeout(done, ms));
const CANDIDATES = [
  process.env.WAND_BROWSER_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

export function chromeBinary() {
  const found = CANDIDATES.find(candidate => existsSync(candidate));
  if (!found) throw Error(`No Chrome binary; set WAND_BROWSER_BIN (looked in ${CANDIDATES.join(", ")})`);
  return found;
}

/** Chrome publishes the bound port here when asked for --remote-debugging-port=0. */
export function readPublishedChromePort(profileDir) {
  try {
    const [first] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n");
    const port = Number.parseInt(first, 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch { return null; }
}

export async function stopChromeProcess(child, profileDir) {
  if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  for (let attempt = 0; child && child.exitCode === null && attempt < 50; attempt += 1) await pause(20);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
}

/** Open a CDP socket on a page target; the caller drives the socket directly. */
export async function openChromeConnection(url, extraArgs = []) {
  const profileDir = mkdtempSync(join(tmpdir(), "wand-fixture-chrome-"));
  const child = spawn(chromeBinary(), [
    "--headless=new", `--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-gpu", "--hide-scrollbars",
    ...extraArgs, url,
  ], { stdio: "ignore" });
  let port = null;
  for (let attempt = 0; attempt < 150 && !port; attempt += 1) {
    if (child.exitCode !== null) throw Error(`Chrome exited during startup (code ${child.exitCode})`);
    port = readPublishedChromePort(profileDir);
    if (!port) await pause(100);
  }
  if (!port) { await stopChromeProcess(child, profileDir); throw Error("Chrome did not publish a DevTools port"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
  if (!target) { await stopChromeProcess(child, profileDir); throw Error("Chrome published no page target"); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(Error("CDP socket failed")), { once: true });
  });
  return { port, profileDir, socket, close: async () => {
    try { socket.close(); } catch { /* the fixture only needs the process and profile gone */ }
    await stopChromeProcess(child, profileDir);
  } };
}
