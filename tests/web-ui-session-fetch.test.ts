import assert from "node:assert/strict";
import test from "node:test";
import { compactSessionFetch } from "../src/web-ui/browser/session-fetch.js";
import { sessionFetchModule } from "./helpers/session-fetch-harness.js";

test("compact session requests preserve body, cancellation and caller-owned options", async (context) => {
  const response = new Response("{\"error\":\"not accepted\"}", { status: 409 });
  const transport = Promise.resolve(response);
  const fetchMock = context.mock.method(globalThis, "fetch", () => transport);
  const init: RequestInit = {
    method: "POST", credentials: "same-origin", body: "{\"input\":\"draft\"}",
    signal: new AbortController().signal,
    headers: { "Content-Type": "application/json", "X-Wand-Tool-Projection": "full" },
  };
  assert.equal(compactSessionFetch("/api/sessions/A/input", init), transport);
  const [url, sent] = fetchMock.mock.calls[0]!.arguments as unknown as [string, RequestInit];
  assert.equal(url, "/api/sessions/A/input");
  assert.deepEqual({ ...sent, headers: undefined }, { ...init, headers: undefined });
  assert.deepEqual([...new Headers(sent.headers)], [["content-type", "application/json"], ["x-wand-tool-projection", "compact"]]);
  assert.equal((init.headers as Record<string, string>)["X-Wand-Tool-Projection"], "full");
  assert.equal(await transport, response);
  assert.equal(response.bodyUsed, false, "status and body remain for the caller's delivery classification");
});

test("compact session fetch keeps default options and rejection identity", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch");
  for (const failure of [new TypeError("Failed to fetch"), new DOMException("cancelled", "AbortError")]) {
    const transport = Promise.reject(failure);
    fetchMock.mock.mockImplementation(() => transport);
    const pending = compactSessionFetch("/api/sessions/A");
    assert.equal(pending, transport);
    await assert.rejects(pending, (error: unknown) => error === failure);
    const sent = fetchMock.mock.calls.at(-1)!.arguments[1] as RequestInit;
    assert.deepEqual([...new Headers(sent.headers)], [["x-wand-tool-projection", "compact"]]);
  }
});

for (const [name, createHeaders] of Object.entries({
  record: () => ({ "Content-Type": "application/json", "x-wand-tool-projection": "full" }),
  Headers: () => new Headers({ "Content-Type": "application/json", "x-wand-tool-projection": "full" }),
  tuples: (): [string, string][] => [["Content-Type", "application/json"], ["x-wand-tool-projection", "full"]],
  mixedCaseDuplicates: () => ({ "Content-Type": "application/json", "x-wand-tool-projection": "full", "X-Wand-Tool-Projection": "legacy" }),
})) {
  test(`compact session fetch normalizes ${name} without mutating the caller`, async (context) => {
    const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response());
    const headers = createHeaders();
    const before = [...new Headers(headers)];
    await compactSessionFetch(new URL("http://localhost/api/sessions/A"), { headers });
    const sent = fetchMock.mock.calls[0]!.arguments[1] as RequestInit;
    assert.deepEqual([...new Headers(sent.headers)], [["content-type", "application/json"], ["x-wand-tool-projection", "compact"]]);
    assert.deepEqual([...new Headers(headers)], before);
  });
}

test("compact session fetch preserves Request input, body and inherited headers", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response());
  const request = new Request("http://localhost/api/sessions/A/input", {
    method: "POST", body: "draft", signal: new AbortController().signal,
    headers: { "Content-Type": "application/json", "X-Request-Id": "test-request", "X-Wand-Tool-Projection": "full" },
  });
  await compactSessionFetch(request, { headers: undefined, credentials: "same-origin" });
  const [input, sent] = fetchMock.mock.calls[0]!.arguments as unknown as [Request, RequestInit];
  assert.equal(input, request);
  assert.equal(sent.credentials, "same-origin");
  const headers = new Headers(sent.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-request-id"), "test-request");
  assert.equal(headers.get("x-wand-tool-projection"), "compact");
  assert.equal(request.headers.get("x-wand-tool-projection"), "full");
  assert.equal(request.bodyUsed, false);
  const effectiveRequest = new Request(input, sent);
  assert.equal(effectiveRequest.method, "POST");
  assert.equal(await effectiveRequest.text(), "draft");
});

test("explicit init headers replace Request headers, including an empty set", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response());
  const request = new Request("http://localhost/api/sessions/A", { headers: { "X-Request-Only": "inherited" } });
  for (const headers of [{ "X-Init-Only": "replacement" }, new Headers()]) {
    await compactSessionFetch(request, { headers });
    const sent = fetchMock.mock.calls.at(-1)!.arguments[1] as RequestInit;
    const expected = new Headers(headers);
    expected.set("X-Wand-Tool-Projection", "compact");
    assert.deepEqual([...new Headers(sent.headers)], [...expected]);
    assert.equal(new Headers(sent.headers).has("x-request-only"), false);
  }
  assert.equal(request.headers.get("x-request-only"), "inherited");
});

test("invalid headers reject asynchronously before transport starts", async (context) => {
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response());
  for (const headers of [{ "invalid\nname": "value" }, { "x-test": "invalid\nvalue" }]) {
    let pending: Promise<Response> | undefined;
    assert.doesNotThrow(() => { pending = compactSessionFetch("http://localhost/api/sessions/A", { headers }); });
    await assert.rejects(pending!, TypeError);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Request headers survive a wrapper executing in another JavaScript realm", async () => {
  const request = new Request("http://localhost/api/sessions/A", { headers: { "X-Request-Id": "cross-realm" } });
  let received: RequestInit | undefined;
  const api = sessionFetchModule((input: RequestInfo | URL, init: RequestInit) => {
    assert.equal(input, request);
    received = init;
    return Promise.resolve(new Response());
  });
  // This VM has no global Request constructor; the Request belongs to our realm.
  await api.compactSessionFetch(request);
  assert.equal(new Headers(received?.headers).get("x-request-id"), "cross-realm");
  assert.equal(new Headers(received?.headers).get("x-wand-tool-projection"), "compact");
});
