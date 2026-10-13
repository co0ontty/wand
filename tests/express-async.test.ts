import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { asyncRoute, jsonErrorHandler } from "../src/express-async.js";
import { badRequest } from "../src/http-error.js";

async function withServer(handler: express.RequestHandler): Promise<Response> {
  const app = express();
  app.get("/reject", handler);
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${address.port}/reject`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("rejected async routes reach the JSON error middleware without leaking details", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await withServer(asyncRoute(async () => {
      await Promise.resolve();
      throw new Error("internal route detail");
    }));

    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.deepEqual(await response.json(), { error: "请求处理失败。", code: "internal_error" });
  } finally {
    console.error = originalConsoleError;
  }
});

test("typed HTTP errors preserve their user-facing status, code and message", async () => {
  const response = await withServer(asyncRoute(async () => {
    throw badRequest("请检查请求内容。", "invalid_input");
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "请检查请求内容。", code: "invalid_input" });
});
