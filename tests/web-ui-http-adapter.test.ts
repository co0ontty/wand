import assert from "node:assert/strict";
import test from "node:test";
import { HttpResponseError, parseJsonResponse, requestJson } from "../src/web-ui/react/http-adapter.ts";
import { readJson } from "../src/web-ui/react/json-utils.ts";

test("JSON requests preserve object and array payloads", async () => {
  for (const body of [{ ok: true }, [{ id: "task" }]]) {
    assert.deepEqual(await parseJsonResponse(new Response(JSON.stringify(body))), body);
  }
});

test("invalid successful responses cannot masquerade as empty successful state", async () => {
  for (const body of ["<html>proxy response</html>", "", "null", "true", '"ok"']) {
    await assert.rejects(parseJsonResponse(new Response(body)), (error: unknown) => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.status, 200);
      assert.match(error.message, /无效的数据/);
      return true;
    });
    assert.match(String((await readJson(new Response(body))).error), /无效的数据/);
  }
});

test("HTTP errors preserve status and useful server messages", async () => {
  for (const [body, status, message] of [
    ['{"error":"请重新登录"}', 401, "请重新登录"],
    ["<html>unavailable</html>", 503, "503"],
    ['{"error":"目录不可用"}', 200, "目录不可用"],
  ] as const) {
    await assert.rejects(parseJsonResponse(new Response(body, { status })), (error: unknown) => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.status, status);
      assert.ok(error.message.includes(message));
      return true;
    });
  }
});

test("body cancellation is preserved for stale-request suppression", async () => {
  const abort = new DOMException("cancelled", "AbortError");
  const response = { json: async () => { throw abort; } } as unknown as Response;
  await assert.rejects(parseJsonResponse(response), (error: unknown) => error === abort);
  await assert.rejects(readJson(response), (error: unknown) => error === abort);
});

test("network failures offer recovery without losing request cancellation", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(requestJson("/api/wand-tasks"), (error: unknown) => {
    assert.ok(error instanceof HttpResponseError);
    assert.equal(error.status, 0);
    assert.match(error.message, /无法连接服务.*重试/);
    return true;
  });
  const abort = new DOMException("cancelled", "AbortError");
  fetchMock.mock.mockImplementation(async () => { throw abort; });
  await assert.rejects(requestJson("/api/wand-tasks"), (error: unknown) => error === abort);
});
