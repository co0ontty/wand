import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Chrome creates DevToolsActivePort before its contents are fully published. */
export function readPublishedChromePort(portFile) {
  let contents;
  try { contents = readFileSync(portFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const end = contents.indexOf("\n");
  if (end < 0) return null;
  const port = contents.slice(0, end).trim();
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535 ? port : null;
}

/** Stop only the Chrome process created by this fixture, with bounded escalation. */
export async function stopChromeProcess(chrome, exited) {
  if (!chrome.pid || chrome.exitCode !== null || chrome.signalCode !== null) {
    chrome.stderr?.destroy();
    return;
  }
  chrome.kill("SIGTERM");
  let timer;
  try {
    await Promise.race([exited, new Promise(resolveWait => { timer = setTimeout(resolveWait, 1500); })]);
  } finally { clearTimeout(timer); }
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGKILL");
    try {
      await Promise.race([exited, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(`Owned Chrome ${chrome.pid} did not exit after SIGKILL`)), 1500);
      })]);
    } finally { clearTimeout(timer); }
  }
  // Chrome helpers may inherit this diagnostic pipe after the leader has exited.
  // Its output is no longer needed; isolated harnesses still own their process group.
  chrome.stderr?.destroy();
}

/** Shared process readiness and transport only; callers retain their CDP/document semantics. */
export async function openChromeConnection(url = "about:blank", flags = []) {
  const temp = mkdtempSync(join(tmpdir(), "wand-browser-chrome-"));
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--remote-allow-origins=*",
    "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`,
    ...flags, url,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let startupError, startupLog = "";
  chrome.once("error", error => { startupError = error; });
  chrome.stderr.on("data", chunk => { startupLog = (startupLog + chunk.toString()).slice(-8192); });
  let socket;
  const chromeExited = new Promise(resolveExit => {
    chrome.once("exit", resolveExit);
    chrome.once("error", resolveExit);
  });
  let closing;
  const close = () => closing ??= (async () => {
    try {
      socket?.close();
      await stopChromeProcess(chrome, chromeExited);
    } finally {
      try { rmSync(temp, { recursive: true, force: true }); } catch { /* only this fixture's Chrome profile */ }
    }
  })();
  try {
    const portFile = join(temp, "profile/DevToolsActivePort");
    // One wall-clock budget covers complete port publication, target discovery
    // and WebSocket readiness; process failures still fail early.
    const deadline = Date.now() + 30_000;
    let port;
    while (!(port = readPublishedChromePort(portFile))) {
      if (startupError) throw startupError;
      if (chrome.exitCode !== null || chrome.signalCode !== null) throw Error(`Chrome exited before debugging was ready: ${chrome.exitCode ?? chrome.signalCode}; ${startupLog}`);
      if (Date.now() >= deadline) throw Error(`Chrome debugging did not become ready within 30s; ${startupLog}`);
      await pause(50);
    }
    assert.match(port, /^\d{1,5}$/, "Chrome publishes a complete numeric debugging port");
    let page, discoveryError = "no page target";
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (chrome.exitCode !== null || chrome.signalCode !== null) throw Error(`Chrome exited during debugging discovery; ${startupLog}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
        const body = await response.text();
        if (!response.ok) throw Error(`HTTP ${response.status}: ${body.slice(0, 256)}`);
        const pages = JSON.parse(body);
        page = Array.isArray(pages) && pages.find(target => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
        if (page) break;
        discoveryError = "no page target";
      } catch (error) { discoveryError = error.message; }
      await pause(50);
    }
    if (!page) throw Error(`Chrome page discovery did not become ready within 30s: ${discoveryError}; ${startupLog}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, "open", { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    return { socket, close };
  } catch (error) {
    await close();
    throw error;
  }
}
