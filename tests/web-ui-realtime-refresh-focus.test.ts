import assert from "node:assert/strict";
import test from "node:test";
import { runFocusBrowser } from "./antd-chat-browser.test.js";

test("tool disclosures retain focus through streaming, pagination, retries and view changes", { timeout: 180_000 }, async (t) => {
  // 浏览器回归默认关闭：本地 npm test 只跑单测；CI（和需要时手动）用 WAND_BROWSER_E2E=1 打开。
  if (process.env.WAND_BROWSER_E2E !== "1") {
    t.skip("set WAND_BROWSER_E2E=1 to run the Chrome CDP tool disclosure regression");
    return;
  }
  const result = await runFocusBrowser({ matrix: ["desktop"], coreOnly: false,
    output: process.env.FOCUS_RESULT_PATH });
  assert.equal(result.ok, true);
  assert.ok(result.cases.some((entry: any) => entry.name === "block-fill retains original source group"));
  assert.ok(result.cases.some((entry: any) => entry.name === "cross-message result fetches open detail once"));
  assert.ok(result.cases.some((entry: any) => entry.name === "ABA"));
  assert.ok(result.cases.some((entry: any) => entry.name === "close-reopen"));
});
