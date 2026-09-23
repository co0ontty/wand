import assert from "node:assert/strict";
import test from "node:test";
import {
  cachedTerminalHistory,
  forgetTerminalHistory,
  loadTerminalHistory,
  recordTerminalHistoryChunk,
  resetTerminalHistory,
} from "../src/web-ui/browser/terminal-history.js";

const base = { version: 1, data: "recent", pending: [], historyBefore: 160, historyRevision: 5 };

test("terminal scroll fetches one bounded page only on demand and preserves live bytes", async () => {
  const urls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const before = Number(new URL(String(input), "http://localhost").searchParams.get("before"));
    return new Response(JSON.stringify({ data: `older-${before}`, separator: "\r\n",
      start: before - 80, before, revision: 5 }), { status: 200 });
  }) as typeof fetch;
  try {
    resetTerminalHistory("terminal-test", base);
    assert.equal(urls.length, 0);
    recordTerminalHistoryChunk("terminal-test", "live");
    const applied: Array<{ data: string; pending: unknown[]; rows: number }> = [];
    const apply = (snapshot: typeof base, rows: number) => {
      applied.push({ data: snapshot.data, pending: snapshot.pending, rows });
      return true;
    };
    await Promise.all([
      loadTerminalHistory("terminal-test", apply),
      loadTerminalHistory("terminal-test", apply),
    ]);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("before=160&revision=5"));
    assert.equal(applied[0].data, "older-160\r\nrecent");
    assert.deepEqual(applied[0].pending, [{ type: "data", data: "live" }]);
    assert.equal(applied[0].rows, 80);
    assert.equal(cachedTerminalHistory("terminal-test", base)?.data, "older-160\r\nrecent");
    assert.deepEqual(cachedTerminalHistory("terminal-test", base)?.pending, [{ type: "data", data: "live" }]);
    await loadTerminalHistory("terminal-test", apply);
    assert.equal(urls.length, 2);
    assert.equal(applied[1].data, "older-80\r\nolder-160\r\nrecent");
    await loadTerminalHistory("terminal-test", apply);
    assert.equal(urls.length, 2, "oldest line should stop pagination");
  } finally {
    forgetTerminalHistory("terminal-test");
    globalThis.fetch = previousFetch;
  }
});

test("history fetch does not advance the cursor when the terminal was unmounted", async () => {
  const previousFetch = globalThis.fetch;
  const cursors: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const before = Number(new URL(String(input), "http://localhost").searchParams.get("before"));
    cursors.push(before);
    return new Response(JSON.stringify({ data: "page", separator: "\r\n", start: before - 80,
      before, revision: 5 }), { status: 200 });
  }) as typeof fetch;
  try {
    resetTerminalHistory("terminal-unmounted", base);
    await loadTerminalHistory("terminal-unmounted", () => false);
    assert.equal(cachedTerminalHistory("terminal-unmounted", base)?.data, "recent");
    let actual = "";
    await loadTerminalHistory("terminal-unmounted", (snapshot) => {
      actual = snapshot.data;
      return true;
    });
    assert.deepEqual(cursors, [160, 160]);
    assert.equal(actual, "page\r\nrecent");
    assert.equal(cachedTerminalHistory("terminal-unmounted", { ...base }), null,
      "only the same cached baseline may be replayed; a fresh init must reset the cursor");
  } finally {
    forgetTerminalHistory("terminal-unmounted");
    globalThis.fetch = previousFetch;
  }
});

test("resync invalidates an in-flight page rather than joining histories", async () => {
  const previousFetch = globalThis.fetch;
  let respond!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve; })) as typeof fetch;
  try {
    resetTerminalHistory("terminal-stale", base);
    let applied = false;
    const loading = loadTerminalHistory("terminal-stale", () => { applied = true; return true; });
    resetTerminalHistory("terminal-stale", { ...base, historyRevision: 6 });
    respond(new Response(JSON.stringify({ data: "stale", separator: "\r\n", start: 80,
      before: 160, revision: 5 }), { status: 200 }));
    await loading;
    assert.equal(applied, false);
  } finally {
    forgetTerminalHistory("terminal-stale");
    globalThis.fetch = previousFetch;
  }
});
