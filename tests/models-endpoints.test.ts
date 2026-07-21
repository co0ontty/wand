import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ModelCommandRunner } from "../src/models.js";
import { startServer } from "../src/server.js";

function createCommandRunner(): ModelCommandRunner {
  return async (file, args) => {
    if (file === "claude" && args.join(" ") === "--version") {
      return { stdout: "2.1.149\n", stderr: "" };
    }
    if (file === "claude" && args[0] === "--model" && args[1] === "claude-endpoint-good") {
      return { stdout: "ok\n", stderr: "" };
    }
    if (file === "qodercli" && args.join(" ") === "--list-models") {
      return {
        stdout: [
          "MODEL",
          "Frontier Model (qoder-frontier-1)",
          "Custom Model (zhipu/glm5.2-cp)",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error(`Unavailable command: ${file} ${args.join(" ")}`);
  };
}

test("model endpoints return candidates and persist only positive verification", async () => {
  process.env.WAND_TEST_MODE = "1";
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-models-server-"));
  const configPath = path.join(dir, "config.json");
  const handle = await startServer({
    ...defaultConfig(),
    host: "127.0.0.1",
    port: 0,
    https: false,
    password: "test-password",
    appSecret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    startupCommands: [],
    defaultModel: "claude-endpoint-good",
  }, configPath, {
    modelRefreshOptions: () => ({
      env: {},
      commandRunner: createCommandRunner(),
      apiKey: "test-key",
      modelsApi: {
        list: async function* () {
          yield { id: "claude-api-candidate", display_name: "API Candidate" };
        },
      },
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    }),
  });

  try {
    const baseUrl = handle.urls[0]!.url;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password", client: "browser-extension" }),
    });
    const { appToken } = await login.json() as { appToken?: string };
    assert.ok(appToken);
    const headers = { Authorization: `Bearer ${appToken}` };

    const initial = await fetch(`${baseUrl}/api/models`, { headers });
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as { models: Array<{ id: string; availability?: string }> };
    assert.equal(initialBody.models.find((model) => model.id === "claude-endpoint-good")?.availability, "candidate");
    assert.equal(initialBody.models.some((model) => model.id === "claude-api-candidate"), false);

    const refreshed = await fetch(`${baseUrl}/api/models/refresh`, { method: "POST", headers });
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json() as {
      models: Array<{ id: string; availability?: string }>;
      qoderModels: Array<{ id: string; label: string }>;
    };
    assert.equal(refreshedBody.models.find((model) => model.id === "claude-endpoint-good")?.availability, "verified");
    assert.equal(refreshedBody.models.find((model) => model.id === "claude-api-candidate")?.availability, "candidate");
    assert.deepEqual(
      refreshedBody.qoderModels.filter((model) => ["qoder-frontier-1", "zhipu/glm5.2-cp"].includes(model.id)),
      [
        { id: "qoder-frontier-1", label: "Frontier Model" },
        { id: "zhipu/glm5.2-cp", label: "Custom Model" },
      ],
    );

    const cached = await fetch(`${baseUrl}/api/models`, { headers });
    const cachedBody = await cached.json() as { models: Array<{ id: string; availability?: string }> };
    assert.equal(cachedBody.models.find((model) => model.id === "claude-endpoint-good")?.availability, "verified");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
