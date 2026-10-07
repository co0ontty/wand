import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function openBrowser(url, width = 1440, height = 1000) {
  const temp = mkdtempSync(join(tmpdir(), "wand-sidebar-ux-"));
  const browser = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--ignore-certificate-errors",
    "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, url,
  ], { stdio: "ignore" });
  let socket;
  try {
    const portFile = join(temp, "profile/DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome must start");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = pages.find(p => p.type === "page");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await once(socket, "open");
    const pending = new Map(); const errors = []; let sequence = 0;
    socket.addEventListener("message", event => {
      const response = JSON.parse(event.data);
      if (response.method === "Runtime.exceptionThrown") errors.push(response.params.exceptionDetails.exception?.description ?? response.params.exceptionDetails.text);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id); clearTimeout(request.timer);
      if (response.error) request.reject(new Error("Browser command rejected: " + request.method));
      else request.resolve(response.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser deadline: " + method)); }, 15000);
      pending.set(id, { method, timer, resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error("Browser evaluation failed");
      return result.result.value;
    };
    const wait = async (expression, label = "DOM ready") => {
      for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await pause(40); }
      throw new Error("Browser condition missing: " + label);
    };
    const settle = async () => {
      await evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
      for (let i = 0; i < 100; i++) {
        if (!await evaluate("document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))")) return;
        await pause(30);
      }
    };
    const click = async (selector, button = "left") => {
      await settle();
      const rect = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      assert.ok(rect, "Click target exists: " + selector);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button, clickCount: 1 });
      await settle();
    };
    const key = async name => {
      const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ContextMenu: 93 };
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: codes[name] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: codes[name] });
      await settle();
    };
    const screenshot = async path => {
      await settle();
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(shot.data, "base64"));
    };
    await send("Runtime.enable"); await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.bringToFront");
    return { send, evaluate, wait, click, key, settle, screenshot, errors,
      async close() {
        socket.close(); browser.kill();
        await Promise.race([once(browser, "exit"), pause(2000)]);
        // Chrome may still be flushing its profile; a leftover temp dir is not a failure.
        try { rmSync(temp, { recursive: true, force: true }); }
        catch { try { await pause(500); rmSync(temp, { recursive: true, force: true }); } catch {} }
      },
    };
  } catch (error) {
    socket?.close(); browser.kill(); rmSync(temp, { recursive: true, force: true }); throw error;
  }
}
