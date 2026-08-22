import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import type { SessionSnapshot } from "../src/types.js";

test("commands endpoint dispatches shell requests without a provider command", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-shell-route-"));
  const configPath = path.join(root, "config.json");
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    startupCommands: [],
  }, configPath);
  t.after(async () => {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  });

  const calls: unknown[][] = [];
  handle.processManager.startShell = ((...args: unknown[]) => {
    calls.push(args);
    return {
      id: "shell-route-1",
      sessionKind: "pty",
      runner: "pty",
      command: defaultConfig().shell,
      cwd: root,
      mode: "default",
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: "",
      archived: false,
      archivedAt: null,
      claudeSessionId: null,
    } satisfies SessionSnapshot;
  }) as typeof handle.processManager.startShell;

  const login = await fetch(`${handle.urls[0]!.url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
  });
  const { appToken } = await login.json() as { appToken?: string };
  assert.ok(appToken);

  const response = await fetch(`${handle.urls[0]!.url}/api/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ shell: true, cwd: root, cols: 92, rows: 27 }),
  });

  assert.equal(response.status, 201);
  const created = await response.json() as SessionSnapshot;
  assert.equal(created.id, "shell-route-1");
  assert.equal(created.provider, undefined);
  assert.equal(calls.length, 1);
  const [cwd, mode, opts] = calls[0] as [string, string, {
    worktreeEnabled?: boolean;
    cols?: number;
    rows?: number;
    sessionSource?: string;
    workspaceId?: string;
    workspaceTaskId?: string;
  }];
  assert.equal(cwd, root);
  assert.equal(mode, "default");
  assert.equal(opts.worktreeEnabled, false);
  assert.equal(opts.cols, 92);
  assert.equal(opts.rows, 27);
  assert.equal(opts.sessionSource, "interactive");
  assert.equal(typeof opts.workspaceId, "string");
  assert.ok(opts.workspaceId);
  assert.equal(opts.workspaceTaskId, undefined);

  const inputCalls: Array<[string, string, string | undefined, string | undefined]> = [];
  handle.processManager.get = ((id: string) => id === created.id ? created : undefined) as
    typeof handle.processManager.get;
  handle.processManager.sendInput = ((id, input, view, shortcutKey) => {
    inputCalls.push([id, input, view, shortcutKey]);
    return { ...created, output: "x".repeat(200_000) };
  }) as typeof handle.processManager.sendInput;

  const inputResponse = await fetch(`${handle.urls[0]!.url}/api/sessions/${created.id}/input`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: "\r",
      view: "terminal",
      shortcutKey: "enter_text",
      responseMode: "accepted",
    }),
  });

  assert.equal(inputResponse.status, 202);
  assert.deepEqual(await inputResponse.json(), { accepted: true });
  assert.deepEqual(inputCalls, [[created.id, "\r", "terminal", "enter_text"]]);
});
