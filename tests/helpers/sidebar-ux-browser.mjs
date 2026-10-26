import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { openChromeConnection } from "./browser-process.mjs";
import { BrowserCommandError, createDocumentEvaluator, waitForBrowserCondition } from "./browser-document.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function openBrowser(url, width = 1440, height = 1000) {
  const browser = await openChromeConnection(url, ["--disable-gpu", "--ignore-certificate-errors"]);
  const { socket } = browser;
  try {
    const pending = new Map(); const errors = []; let sequence = 0;
    socket.addEventListener("message", event => {
      const response = JSON.parse(event.data);
      documentEvaluator.observe(response);
      if (response.method === "Runtime.exceptionThrown") errors.push(response.params.exceptionDetails.exception?.description ?? response.params.exceptionDetails.text);
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id); clearTimeout(request.timer);
      if (response.error) request.reject(new BrowserCommandError(request.method, response.error));
      else request.resolve(response.result);
    });
    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer); request.reject(new Error("Chrome closed during " + request.method));
      }
      pending.clear();
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser deadline: " + method)); }, 15000);
      pending.set(id, { method, timer, resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const documentEvaluator = createDocumentEvaluator(send);
    const evaluate = documentEvaluator.evaluate;
    const wait = (expression, label = "DOM ready") => waitForBrowserCondition(evaluate, expression, label);
    const settle = async () => {
      // rc-trigger stages visibility, measurement, alignment and motion across frames.
      // Two frames can observe a submenu before its CSS/align prepare phase completes.
      await evaluate("document.fonts.ready.then(()=>new Promise(resolve=>{let count=0;function frame(){if(++count>=6)resolve();else requestAnimationFrame(frame)}requestAnimationFrame(frame)}))");
      for (let i = 0; i < 100; i++) {
        if (!await evaluate("document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))")) return;
        await pause(30);
      }
    };
    const click = async (selector, button = "left") => {
      await settle();
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'});true`);
      // Native context menus close on scroll. Deliver the scroll event before opening one.
      await settle();
      const rect = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
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
    const { frameTree } = await send("Page.getFrameTree");
    documentEvaluator.setMainFrame(frameTree.frame.id);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.bringToFront");
    return { send, evaluate, wait, click, key, settle, screenshot, errors, close: browser.close };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
