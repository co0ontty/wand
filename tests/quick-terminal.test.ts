import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { toSessionDetailDTO } from "../src/session-transport.js";
import type { SessionSnapshot } from "../src/types.js";
import { QUICK_TERMINAL_KEY, readQuickTerminalPreference, saveQuickTerminalPreference, resolveQuickTerminal, QuickTerminalUnavailableError } from "../src/web-ui/react/quick-terminal/state.js";
import { terminalConnectionLabel } from "../src/web-ui/react/quick-terminal/runtime.js";

test("terminal connection state follows its own session and shared transport only", () => {
  assert.equal(terminalConnectionLabel("q", { type: "error" }), undefined);
  assert.equal(terminalConnectionLabel("q", { type: "pty_error", sessionId: "other" }), undefined);
  assert.equal(terminalConnectionLabel("q", { type: "disconnected" }), "已断开 · 自动重连中");
  assert.equal(terminalConnectionLabel("q", { type: "init", sessionId: "q", data: { status: "running" } }), "已连接");
  assert.equal(terminalConnectionLabel("q", { type: "status", sessionId: "q", data: { status: "exited" } }), "进程已结束");
  for (const status of ["running", "idle"]) {
    assert.equal(terminalConnectionLabel("q", { type: "status", sessionId: "q", data: { status } }), "已连接");
    assert.equal(terminalConnectionLabel("q", { type: "status", sessionId: "other", data: { status } }), undefined);
  }
});

test("quick terminal defaults, malformed storage, and client-local persistence", () => {
  for (const raw of [null, "broken", "null", '{"dock":"left","sessionId":123}']) {
    assert.deepEqual(readQuickTerminalPreference({ getItem: () => raw }), { dock: "right", sessionId: "" });
  }
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.equal(saveQuickTerminalPreference(storage, { dock: "bottom", sessionId: "pty-1" }), true);
  assert.ok(values.has(QUICK_TERMINAL_KEY));
  assert.deepEqual(readQuickTerminalPreference(storage), { dock: "bottom", sessionId: "pty-1" });
  assert.equal(saveQuickTerminalPreference({ setItem() { throw new Error("denied"); } }, { dock: "right", sessionId: "" }), false);
});

test("quick terminal creation uses the existing bare login shell route and server home fallback", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(toSessionDetailDTO({ id: "pty-1", sessionKind: "pty", sessionSource: "quick-terminal", cwd: "/host/home", status: "running", output: "", queuedMessages: [] } as unknown as SessionSnapshot)));
  }) as typeof fetch;
  await resolveQuickTerminal("", "", fetchImpl);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { kind: "pty", shell: true, cwd: "~", sessionSource: "quick-terminal" });
  await resolveQuickTerminal("pty-1", "/new-worktree", fetchImpl);
  assert.equal(requests[1].url, "/api/sessions/pty-1");
  assert.equal(requests[1].init?.method, undefined, "reopening only reads the original shell; does not change its cwd or recreate it");
  assert.equal(requests.length, 2, "an already marked shortcut needs no claim mutation");
});

test("a saved legacy bare shell is claimed once by its exact ID without creating a process", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let sessionSource = "interactive";
  const fetchImpl = (async (url, init) => {
    const method = init?.method ?? "GET";
    requests.push({ url: String(url), method });
    if (method === "PUT") sessionSource = "quick-terminal";
    return new Response(JSON.stringify({ id: "legacy/id", sessionKind: "pty", sessionSource, cwd: "/original", status: "running" }));
  }) as typeof fetch;
  const migrated = await resolveQuickTerminal("legacy/id", "/new-worktree", fetchImpl);
  assert.deepEqual(requests, [
    { url: "/api/sessions/legacy%2Fid", method: "GET" },
    { url: "/api/sessions/legacy%2Fid/quick-terminal", method: "PUT" },
  ]);
  assert.equal(migrated.cwd, "/original");
  assert.equal(migrated.navigationChanged, true);
  assert.equal((await resolveQuickTerminal("legacy/id", "", fetchImpl)).navigationChanged, false);
  assert.deepEqual(requests.at(-1), { url: "/api/sessions/legacy%2Fid", method: "GET" });
  assert.equal(requests.filter(request => request.method === "PUT").length, 1);
});

test("claim errors never classify the saved shell as missing or create a replacement", async () => {
  for (const failure of [401, 403, 404, 410, 503, "network", "parse", "wrong-id", "wrong-source"]) {
    const methods: string[] = [];
    const fetchImpl = (async (_url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      const snapshot = { id: "legacy", sessionKind: "pty", sessionSource: "interactive", cwd: "/work", status: "running" };
      if (method === "GET") return new Response(JSON.stringify(snapshot));
      if (typeof failure === "number") return new Response("claim unavailable", { status: failure });
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "parse") return new Response("{broken");
      return new Response(JSON.stringify({ ...snapshot, id: failure === "wrong-id" ? "another" : "legacy", sessionSource: failure === "wrong-source" ? "interactive" : "quick-terminal" }));
    }) as typeof fetch;
    await assert.rejects(resolveQuickTerminal("legacy", "", fetchImpl), error => {
      assert.equal(error instanceof QuickTerminalUnavailableError, false, `claim ${failure} is not lookup failure`);
      return true;
    });
    assert.deepEqual(methods, ["GET", "PUT"]);
  }
});

test("saved terminal lookup rejects a different response ID before mounting or claiming", async () => {
  for (const sessionSource of ["interactive", "quick-terminal"]) {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(JSON.stringify({ id: "another-shell", sessionKind: "pty", sessionSource }));
    }) as typeof fetch;
    await assert.rejects(resolveQuickTerminal("saved-shell", "", fetchImpl));
    assert.equal(requests, 1);
  }
});

test("failed or ambiguous terminal creation is never automatically retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response("upstream error", { status: 503 }); }) as typeof fetch;
  await assert.rejects(resolveQuickTerminal("", "/worktree", fetchImpl), /创建终端未确认/);
  assert.equal(calls, 1);
  await assert.rejects(resolveQuickTerminal("gone", "", fetchImpl), /不会自动新建/);
  assert.equal(calls, 2);
});

test("quick terminal rejects structured/provider session references", async () => {
  for (const snapshot of [{ sessionKind: "structured", provider: "pi" }, { sessionKind: "pty", provider: "claude" }]) {
    const methods: string[] = [];
    const fetchImpl = (async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ id: "wrong", ...snapshot }));
    }) as typeof fetch;
    await assert.rejects(resolveQuickTerminal("wrong", "", fetchImpl), /终端响应无效/);
    assert.deepEqual(methods, ["GET"], "reject before claiming an agent's session");
  }
});

test("only a missing saved terminal permits explicit replacement", async () => {
  for (const status of [401, 403, 404, 410, 408, 409, 429, 500, 503]) {
    const requests: RequestInit[] = [];
    const fetchImpl = (async (_url, init) => {
      requests.push(init ?? {});
      return new Response("unavailable", { status });
    }) as typeof fetch;
    await assert.rejects(resolveQuickTerminal("saved-shell", "/worktree", fetchImpl), error => {
      assert.equal(error instanceof QuickTerminalUnavailableError, status === 404 || status === 410, `HTTP ${status}`);
      if (status === 401) assert.match(String(error), /登录/);
      if (status === 403) assert.match(String(error), /权限/);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, undefined, "lookup never creates a replacement automatically");
    await assert.rejects(resolveQuickTerminal("", "/worktree", fetchImpl), error => {
      assert.equal(error instanceof QuickTerminalUnavailableError, false, "even a creation 404 does not confirm non-delivery");
      return true;
    });
  }
});

test("network and successful-response parsing failures never make a terminal replaceable", async () => {
  for (const sessionId of ["saved-shell", ""]) {
    for (const failure of ["network", "parse"]) {
      let requests = 0;
      const fetchImpl = (async () => {
        requests++;
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response("{broken");
      }) as typeof fetch;
      await assert.rejects(resolveQuickTerminal(sessionId, "/worktree", fetchImpl), error => {
        assert.equal(error instanceof QuickTerminalUnavailableError, false);
        return true;
      });
      assert.equal(requests, 1);
    }
  }
});

test("quick terminal layout keeps draft and terminal identities across docks and reopen", {
  skip: process.env.WAND_QUICK_TERMINAL_BROWSER !== "1", timeout: 150_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/quick-terminal-browser.mjs"], { encoding: "utf8", timeout: 145_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
