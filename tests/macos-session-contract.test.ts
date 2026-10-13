import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { SESSION_PROVIDERS } from "../src/provider-catalog.js";
import { registerWorkspaceRoutes } from "../src/server-workspace-routes.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";
import { agentToolDisplayName } from "../src/web-ui/provider-identity.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/native-session-identity.json", import.meta.url), "utf8",
)) as {
  providers: string[];
  cases: Array<{
    name: string;
    payload: SessionSnapshot & { engine?: "core" | "cli"; workspaceTaskId?: string };
    expected: { providerLabel: string };
  }>;
};

test("macOS shared execution fixture agrees with the server/Web provider truth", () => {
  assert.deepEqual(fixture.providers, [...SESSION_PROVIDERS]);
  // Server-only checkout does not initialize native submodules. The macOS mirror
  // stays self-contained for its own XCTest lane; verify equality when present.
  const mirror = new URL("../macos/WandTests/Fixtures/session-identity.json", import.meta.url);
  if (existsSync(mirror)) assert.deepEqual(JSON.parse(readFileSync(mirror, "utf8")), fixture);
  for (const entry of fixture.cases) {
    assert.equal(
      agentToolDisplayName(entry.payload.provider, entry.payload.structuredState?.engine ?? entry.payload.engine),
      entry.expected.providerLabel,
      entry.name,
    );
  }
});

test("workspace and task APIs project the actual runtime engine without duplicating session state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-macos-identity-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const app = express();
  registerWorkspaceRoutes(app, storage);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const workspace = storage.createWorkspace({ name: "Fixture", cwd: root });
    for (const name of ["Pi CLI", "Wand Agent"]) {
      const payload = fixture.cases.find((entry) => entry.name === name)!.payload;
      storage.saveSession({
        id: payload.id, provider: "pi", runner: "pi-cli-json", sessionKind: "structured",
        command: "pi", cwd: root, mode: "default", status: "idle", exitCode: null,
        startedAt: "2026-10-12T00:00:00Z", endedAt: null, output: "",
        workspaceId: workspace.id, structuredState: payload.structuredState,
      });
    }
    const detail = await (await fetch(`${base}/api/workspaces/${workspace.id}`)).json() as {
      sessions: Array<{ id: string; engine?: string }>;
    };
    const groups = await (await fetch(`${base}/api/tasks`)).json() as Array<{
      standaloneSessions: Array<{ id: string; engine?: string }>;
    }>;
    for (const sessions of [detail.sessions, groups.flatMap((group) => group.standaloneSessions)]) {
      assert.equal(sessions.find((session) => session.id === "pi-cli")?.engine, "cli");
      assert.equal(sessions.find((session) => session.id === "wand-agent")?.engine, "core");
    }
    assert.equal(storage.getSession("wand-agent")?.structuredState?.engine, "core");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
