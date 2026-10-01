import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverPiEndpointModels } from "../src/pi-model-discovery.js";
import { ModelCommandRunner, refreshModels } from "../src/models.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function writePiModelsConfig(agentDir: string, providers: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers }), "utf8");
}

test("Pi model discovery imports and paginates models from its configured LLM endpoints", async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "wand-pi-model-discovery-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await writePiModelsConfig(agentDir, {
    OpenAI: {
      api: "openai-responses",
      baseUrl: "https://openai.example/v1",
      apiKey: "literal-openai-secret",
      models: [{ id: "configured-model" }],
    },
    xiaomai: {
      api: "anthropic-messages",
      baseUrl: "https://claude.example",
      apiKey: "$CLAUDE_MODELS_KEY",
    },
    "huniu-gemini": {
      api: "google-generative-ai",
      baseUrl: "https://gemini.example/v1beta",
      apiKey: "literal-google-secret",
      headers: { "x-tenant-token": "$GEMINI_TENANT_TOKEN" },
    },
  });

  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push(`${url.host}${url.pathname}${url.searchParams.has("after") ? "?after" : ""}`);
    if (url.host === "openai.example") {
      assert.equal(headers.get("authorization"), "Bearer literal-openai-secret");
      if (url.searchParams.has("after")) {
        assert.equal(url.searchParams.get("after"), "gpt-5-nano");
        return response({ data: [{ id: "gpt-5-mini" }], has_more: false });
      }
      return response({ data: [{ id: "gpt-5-nano" }], has_more: true, last_id: "gpt-5-nano" });
    }
    if (url.host === "claude.example") {
      assert.equal(headers.get("x-api-key"), "claude-test-secret");
      assert.equal(headers.get("anthropic-version"), "2023-06-01");
      return response({
        data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }],
        has_more: false,
      });
    }
    assert.equal(url.host, "gemini.example");
    assert.equal(url.searchParams.has("key"), false, "API keys must not be placed in request URLs");
    assert.equal(headers.get("x-goog-api-key"), "literal-google-secret");
    assert.equal(headers.get("x-tenant-token"), "gemini-tenant-test-secret");
    if (url.searchParams.has("pageToken")) {
      assert.equal(url.searchParams.get("pageToken"), "next-page");
      return response({ models: [{ name: "models/gemini-3.1-pro" }] });
    }
    return response({
      models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash" }],
      nextPageToken: "next-page",
    });
  };
  const env = {
    CLAUDE_MODELS_KEY: "claude-test-secret",
    GEMINI_TENANT_TOKEN: "gemini-tenant-test-secret",
  };

  const discovered = await discoverPiEndpointModels({ agentDir, env, fetchImpl });
  assert.deepEqual(discovered.map((model) => model.id), [
    "OpenAI/gpt-5-nano",
    "OpenAI/gpt-5-mini",
    "xiaomai/claude-sonnet-5-5",
    "huniu-gemini/gemini-3.8-flash",
    "huniu-gemini/gemini-3.1-pro",
  ]);
  assert.equal(discovered.find((model) => model.id === "huniu-gemini/gemini-3.8-flash")?.label,
    "Gemini 3.8 Flash · huniu-gemini/gemini-3.8-flash");
  assert.equal(calls.length, 5, "OpenAI and Gemini cursors should be followed");
  assert.doesNotMatch(JSON.stringify(discovered), /secret|token/i);

  const runner: ModelCommandRunner = async (file, args) => {
    if (file === "pi" && args[0] === "--mode") {
      return {
        stdout: `${JSON.stringify({
          type: "response",
          command: "get_available_models",
          success: true,
          data: { models: [{ provider: "OpenAI", id: "configured-model", name: "Configured" }] },
        })}\n`,
        stderr: "",
      };
    }
    if (file === "claude" && args[0] === "--version") return { stdout: "2.1.149\n", stderr: "" };
    throw new Error("CLI probe unavailable");
  };
  const catalog = await refreshModels({
    env,
    commandRunner: runner,
    piEndpointDiscovery: { enabled: true, agentDir, fetchImpl },
  });
  assert.deepEqual(catalog.piModels.map((model) => model.id), [
    "default",
    "OpenAI/configured-model",
    "OpenAI/gpt-5-nano",
    "OpenAI/gpt-5-mini",
    "xiaomai/claude-sonnet-5-5",
    "huniu-gemini/gemini-3.8-flash",
    "huniu-gemini/gemini-3.1-pro",
  ]);
  assert.doesNotMatch(JSON.stringify(catalog.piModels), /secret|token/i);
});

test("Pi model endpoint discovery skips command-based and unresolved API keys", async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "wand-pi-model-discovery-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  await writePiModelsConfig(agentDir, {
    commandKey: {
      api: "openai-responses",
      baseUrl: "https://models.example/v1",
      apiKey: "!read-secret-from-keychain",
    },
    missingEnvironmentKey: {
      api: "anthropic-messages",
      baseUrl: "https://models.example",
      apiKey: "$MISSING_MODELS_KEY",
    },
  });
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return response({ data: [{ id: "should-not-be-requested" }] });
  };
  assert.deepEqual(await discoverPiEndpointModels({ agentDir, env: {}, fetchImpl }), []);
  assert.equal(calls, 0);
});
