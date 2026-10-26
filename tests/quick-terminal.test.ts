import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { toSessionDetailDTO } from "../src/session-transport.js";
import type { SessionSnapshot } from "../src/types.js";
import { QUICK_TERMINAL_KEY, readQuickTerminalPreference, saveQuickTerminalPreference, resolveQuickTerminal } from "../src/web-ui/react/quick-terminal/state.js";
import { terminalConnectionLabel } from "../src/web-ui/react/quick-terminal/runtime.js";

test("terminal connection state follows its own session and shared transport only", () => {
  assert.equal(terminalConnectionLabel("q", { type: "error" }), undefined);
  assert.equal(terminalConnectionLabel("q", { type: "pty_error", sessionId: "other" }), undefined);
  assert.equal(terminalConnectionLabel("q", { type: "disconnected" }), "已断开 · 自动重连中");
  assert.equal(terminalConnectionLabel("q", { type: "init", sessionId: "q", data: { status: "running" } }), "已连接");
  assert.equal(terminalConnectionLabel("q", { type: "status", sessionId: "q", data: { status: "exited" } }), "进程已结束");
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
    return new Response(JSON.stringify(toSessionDetailDTO({ id: "pty-1", sessionKind: "pty", cwd: "/host/home", status: "running", output: "", queuedMessages: [] } as unknown as SessionSnapshot)));
  }) as typeof fetch;
  await resolveQuickTerminal("", "", fetchImpl);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { kind: "pty", shell: true, cwd: "~", sessionSource: "interactive" });
  await resolveQuickTerminal("pty-1", "/new-worktree", fetchImpl);
  assert.equal(requests[1].url, "/api/sessions/pty-1");
  assert.equal(requests[1].init?.method, undefined, "reopening only reads the original shell; does not change its cwd or recreate it");
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
  const fetchImpl = (async () => new Response(JSON.stringify({ id: "wrong", sessionKind: "structured", provider: "pi" }))) as typeof fetch;
  await assert.rejects(resolveQuickTerminal("wrong", "", fetchImpl), /终端响应无效/);
});

test("quick terminal layout keeps draft and terminal identities across docks and reopen", {
  skip: process.env.WAND_QUICK_TERMINAL_BROWSER !== "1", timeout: 100_000,
}, () => {
  const result = spawnSync(process.execPath, ["tests/helpers/quick-terminal-browser.mjs"], { encoding: "utf8", timeout: 95_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
