import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";
import { BrowserCommandError, BrowserDocumentChangedError, createDocumentEvaluator, waitForBrowserCondition } from "./helpers/browser-document.mjs";

const runtimeError = () => new BrowserCommandError("Runtime.evaluate", { code: -32000, message: "opaque CDP error" });
const navigation = { method: "Page.frameNavigated", params: { frame: { id: "main" } } };
const cleared = { method: "Runtime.executionContextsCleared" };
const instant = { sleep: async () => {}, attempts: 4 };

for (const event of [navigation, cleared, { method: "Page.frameStartedLoading", params: { frameId: "main" } }]) {
  test(`browser document wait recovers lifecycle invalidation: ${event.method}`, async () => {
    let calls = 0;
    const document = createDocumentEvaluator(async (method: string, params: { expression: string }) => {
      assert.equal(method, "Runtime.evaluate");
      assert.equal(params.expression, "newDocumentReady");
      calls++;
      if (calls === 1) {
        document.observe(event);
        throw runtimeError();
      }
      return { result: { value: calls >= 3 } };
    });
    document.setMainFrame("main");
    await waitForBrowserCondition(document.evaluate, "newDocumentReady", "fresh app ready", instant);
    assert.equal(calls, 3, "a surviving page still must satisfy app readiness");
  });
}

test("runtime error with no document change is not retried, regardless of wording", async () => {
  const failure = new BrowserCommandError("Runtime.evaluate", { code: -32000, message: "Inspected target navigated or closed" });
  let calls = 0;
  const document = createDocumentEvaluator(async () => { calls++; throw failure; });
  await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), error => error === failure);
  assert.equal(calls, 1);
});

test("iframe navigation does not invalidate a main-page runtime read", async () => {
  const failure = runtimeError();
  const document = createDocumentEvaluator(async () => {
    document.observe({ method: "Page.frameNavigated", params: { frame: { id: "child", parentId: "main" } } });
    throw failure;
  });
  await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), error => error === failure);
});

test("child-frame loading does not excuse a main-document runtime error", async () => {
  const failure = runtimeError();
  const document = createDocumentEvaluator(async () => {
    document.observe({ method: "Page.frameStartedLoading", params: { frameId: "child" } });
    throw failure;
  });
  document.setMainFrame("main");
  await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), error => error === failure);
});

test("navigation before a read does not excuse a later unrelated protocol error", async () => {
  const failure = runtimeError();
  const document = createDocumentEvaluator(async () => { throw failure; });
  document.observe(navigation);
  await assert.rejects(document.evaluate("ready"), error => error === failure);
});

test("read begun during the main frame loading window can recover a stale context", async () => {
  let calls = 0;
  const document = createDocumentEvaluator(async () => {
    calls++;
    if (calls === 1) throw runtimeError();
    document.observe({ method: "Page.frameStoppedLoading", params: { frameId: "main" } });
    return { result: { value: true } };
  });
  document.setMainFrame("main");
  document.observe({ method: "Page.frameStartedLoading", params: { frameId: "main" } });
  await waitForBrowserCondition(document.evaluate, "ready", "fresh document", instant);
  assert.equal(calls, 2);
});

for (const finished of [
  { method: "Page.frameStoppedLoading", params: { frameId: "main" } },
  { method: "Runtime.executionContextCreated", params: { context: { auxData: { isDefault: true, frameId: "main" } } } },
]) {
  test(`a settled navigation cannot excuse a later error: ${finished.method}`, async () => {
    const failure = runtimeError();
    const document = createDocumentEvaluator(async () => { throw failure; });
    document.setMainFrame("main");
    document.observe({ method: "Page.frameStartedLoading", params: { frameId: "main" } });
    document.observe(finished);
    await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), error => error === failure);
  });
}

test("navigation never hides invalid commands, transport failures or deadlines", async () => {
  for (const failure of [
    new BrowserCommandError("Runtime.evaluate", { code: -32602, message: "invalid parameters" }),
    new BrowserCommandError("Runtime.evaluate", { code: -32601, message: "unknown method" }),
    new BrowserCommandError("Page.reload", { code: -32000, message: "unrelated command" }),
    new Error("Browser deadline: Runtime.evaluate"),
    new Error("transport disconnected"),
  ]) {
    let calls = 0;
    const document = createDocumentEvaluator(async () => { calls++; document.observe(cleared); throw failure; });
    await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), error => error === failure);
    assert.equal(calls, 1);
  }
});

test("actual JavaScript exceptions fail immediately even during navigation", async () => {
  let calls = 0;
  const document = createDocumentEvaluator(async () => {
    calls++;
    document.observe(cleared);
    return { exceptionDetails: { text: "ReferenceError" } };
  });
  await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "app", instant), /Browser evaluation failed/);
  assert.equal(calls, 1);
});

test("document-change retries consume the same bounded wait budget", async () => {
  let calls = 0;
  const document = createDocumentEvaluator(async () => { calls++; document.observe(cleared); throw runtimeError(); });
  await assert.rejects(waitForBrowserCondition(document.evaluate, "ready", "fresh app", instant), /Browser condition missing: fresh app/);
  assert.equal(calls, 4);
});

test("a direct evaluation is never replayed after document invalidation", async () => {
  const failure = runtimeError();
  let calls = 0;
  const document = createDocumentEvaluator(async () => { calls++; document.observe(cleared); throw failure; });
  await assert.rejects(document.evaluate("performAction()"), error => error instanceof BrowserDocumentChangedError && error.cause === failure);
  assert.equal(calls, 1, "only the caller's explicit wait may retry its condition read");
});

test("unmet readiness remains a bounded condition failure", async () => {
  let calls = 0;
  await assert.rejects(waitForBrowserCondition(async () => { calls++; return false; }, "ready", "app", instant), /Browser condition missing: app/);
  assert.equal(calls, 4);
});

test("real Chrome reload resumes a pending condition read only in the new ready document", {
  skip: process.env.WAND_DOCUMENT_NAVIGATION_BROWSER !== "1", timeout: 30_000,
}, async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><script>window.documentMarker=crypto.randomUUID();window.appReady=true;</script>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let browser;
  try {
    browser = await openBrowser(`http://127.0.0.1:${address.port}`);
    await browser.wait("!!window.appReady");
    const oldMarker = await browser.evaluate("window.documentMarker");
    let reads = 0;
    // Hold an asynchronous Runtime.evaluate in the old document. Reload, not
    // a fabricated CDP error, destroys its execution context while it is pending.
    const waiting = waitForBrowserCondition(async (expression: string) => {
      reads++;
      return browser!.evaluate(reads === 1
        ? "window.oldReadStarted=true;new Promise(()=>{})"
        : expression);
    }, `window.appReady&&window.documentMarker!==${JSON.stringify(oldMarker)}`, "fresh ready document");
    // Attach a rejection handler immediately while coordinating the real reload.
    const outcome = waiting.then(() => ({ ok: true }), error => ({ ok: false, error }));
    await browser.wait("window.oldReadStarted===true");
    await browser.send("Page.reload");
    const result = await outcome;
    if (!result.ok) throw result.error;
    assert.ok(reads >= 2);
    assert.notEqual(await browser.evaluate("window.documentMarker"), oldMarker);
    assert.deepEqual(browser.errors, []);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
