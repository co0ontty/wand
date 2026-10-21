import test from "node:test";

test("confirmed queue directory design: real rows, narrow status, hierarchy and activity filters", { timeout: 120_000 }, async t => {
  if (process.env.WAND_QUEUE_DIRECTORY_BROWSER !== "1") {
    t.skip("set WAND_QUEUE_DIRECTORY_BROWSER=1 to exercise production sidebar components in Chrome");
    return;
  }
  const { runQueuedDirectoryBrowser } = await import("./helpers/queue-directory-browser.mjs");
  await runQueuedDirectoryBrowser();
});
