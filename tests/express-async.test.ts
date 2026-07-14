import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { asyncRoute, jsonErrorHandler } from "../src/express-async.js";

test("rejected async routes reach the JSON error middleware", async () => {
  const app = express();
  app.get("/reject", asyncRoute(async () => {
    await Promise.resolve();
    throw new Error("route failed");
  }));
  app.use(jsonErrorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/reject`);

    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.deepEqual(await response.json(), { error: "请求处理失败。" });
  } finally {
    console.error = originalConsoleError;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
