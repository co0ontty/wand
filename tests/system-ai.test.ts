import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateCommitMessageOnly, QuickCommitError, runQuickCommitWithFallback } from "../src/git-quick-commit.js";
import {
  callSystemAiText,
  callSystemAiTextWithFallback,
  discoverCliSystemAiConfig,
  discoverCliSystemAiConfigs,
  mergeSystemAiConfigs,
} from "../src/system-ai.js";

test("CLI discovery copies Claude API settings without mutating the source", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-"));
  try {
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_AUTH_TOKEN: "secret-token" },
      model: "custom-model",
    }));
    const found = discoverCliSystemAiConfig("claude", home);
    assert.ok(found?.id);
    assert.deepEqual({ ...found, id: undefined }, {
      id: undefined,
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://proxy.example",
      apiKey: "secret-token",
      model: "custom-model",
      authHeader: "bearer",
      source: "claude",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI discovery imports every configured API in preferred-provider order", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-all-"));
  try {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: "claude-secret" }, model: "claude-model",
    }));
    writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "codex-secret" }));
    writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "codex-model"\nbase_url = "https://codex.example/v1"\n');
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      model: "first/first-model",
      provider: {
        first: { options: { apiKey: "first-secret", baseURL: "https://first.example/v1" } },
        second: {
          options: { apiKey: "second-secret", baseURL: "https://second.example/v1" },
          models: { "second-model": {} },
        },
      },
    }));

    const found = discoverCliSystemAiConfigs("opencode", home);
    assert.deepEqual(found.map(({ source, baseUrl, model }) => ({ source, baseUrl, model })), [
      { source: "opencode", baseUrl: "https://first.example/v1", model: "first-model" },
      { source: "opencode", baseUrl: "https://second.example/v1", model: "second-model" },
      { source: "claude", baseUrl: "https://api.anthropic.com", model: "claude-model" },
      { source: "codex", baseUrl: "https://codex.example/v1", model: "codex-model" },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI discovery skips malformed profiles without blocking later APIs", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-invalid-"));
  try {
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "not a URL", ANTHROPIC_AUTH_TOKEN: "bad-secret" },
      model: "bad-model",
    }));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
      model: "broken/bad-model",
      provider: {
        broken: { options: { baseURL: "still not a URL", apiKey: "bad-secret" } },
        usable: {
          options: { baseURL: "https://usable.example/v1", apiKey: "usable-secret" },
          models: { "usable-model": {} },
        },
      },
    }));

    const found = discoverCliSystemAiConfigs("claude", home);
    assert.deepEqual(found.map(({ source, baseUrl, model }) => ({ source, baseUrl, model })), [{
      source: "opencode",
      baseUrl: "https://usable.example/v1",
      model: "usable-model",
    }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Grok discovery imports chat_completions profiles with the default first", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-grok-"));
  try {
    mkdirSync(path.join(home, ".grok"));
    writeFileSync(path.join(home, ".grok", "config.toml"), [
      "[models]",
      'default = "primary"',
      "",
      "[model.secondary]",
      'model = "secondary-model"',
      'base_url = "https://secondary.example/v4"',
      "api_key = 'secondary-secret'",
      'api_backend = "chat_completions"',
      "",
      "[model.unsupported]",
      'model = "responses-model"',
      'base_url = "https://responses.example/v1"',
      'api_key = "responses-secret"',
      'api_backend = "responses"',
      "",
      "[model.primary]",
      'model = "primary-model"',
      'base_url = "https://primary.example/api/coding/paas/v4"',
      'api_key = "primary-secret"',
      'api_backend = "chat_completions"',
    ].join("\n"));

    const found = discoverCliSystemAiConfigs("grok", home);
    assert.deepEqual(found.map(({ source, baseUrl, model }) => ({ source, baseUrl, model })), [
      { source: "grok", baseUrl: "https://primary.example/api/coding/paas/v4", model: "primary-model" },
      { source: "grok", baseUrl: "https://secondary.example/v4", model: "secondary-model" },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("system AI config merging keeps caller priority, flattens fallbacks, and deduplicates", () => {
  const merged = mergeSystemAiConfigs(
    [{
      enabled: false,
      protocol: "openai",
      baseUrl: "https://dynamic.example/v1",
      apiKey: "shared-secret",
      model: "shared-model",
      source: "grok",
      fallbacks: [{
        enabled: false,
        protocol: "openai",
        baseUrl: "https://dynamic-fallback.example/v1",
        apiKey: "dynamic-fallback-secret",
        model: "dynamic-fallback-model",
        source: "opencode",
      }],
    }],
    {
      enabled: false,
      protocol: "openai",
      baseUrl: "https://dynamic.example/v1",
      apiKey: "shared-secret",
      model: "shared-model",
      source: "custom",
      fallbacks: [{
        enabled: false,
        protocol: "anthropic",
        baseUrl: "https://legacy.example",
        apiKey: "legacy-secret",
        model: "legacy-model",
        authHeader: "x-api-key",
        source: "claude",
      }],
    },
    undefined,
  );

  assert.ok(merged);
  assert.equal(merged.enabled, true);
  assert.deepEqual(
    [merged, ...(merged.fallbacks ?? [])].map(({ enabled, source, baseUrl, model }) => ({
      enabled, source, baseUrl, model,
    })),
    [
      {
        enabled: true,
        source: "grok",
        baseUrl: "https://dynamic.example/v1",
        model: "shared-model",
      },
      {
        enabled: true,
        source: "opencode",
        baseUrl: "https://dynamic-fallback.example/v1",
        model: "dynamic-fallback-model",
      },
      {
        enabled: true,
        source: "claude",
        baseUrl: "https://legacy.example",
        model: "legacy-model",
      },
    ],
  );
});

test("system AI keeps profiles that differ only by authentication header", () => {
  const merged = mergeSystemAiConfigs(
    {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://same.example/v1",
      apiKey: "same-secret",
      model: "same-model",
      authHeader: "bearer",
    },
    {
      enabled: true,
      protocol: "anthropic",
      baseUrl: "https://same.example/v1",
      apiKey: "same-secret",
      model: "same-model",
      authHeader: "x-api-key",
    },
  );

  assert.ok(merged);
  assert.deepEqual(
    [merged, ...(merged.fallbacks ?? [])].map((profile) => profile.authHeader),
    ["bearer", "x-api-key"],
  );
});

test("system AI tries configured APIs in order with each route's exact model", async () => {
  const requests: Array<{ authorization: string; model: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization ?? "",
        model: (JSON.parse(raw) as { model?: string }).model ?? "",
      });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer first-secret") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "second API result" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const text = await callSystemAiTextWithFallback("prompt", {
      enabled: true,
      protocol: "openai",
      baseUrl,
      apiKey: "first-secret",
      model: "first-model",
      source: "codex",
      fallbacks: [{
        enabled: true,
        protocol: "openai",
        baseUrl,
        apiKey: "second-secret",
        model: "second-model",
        source: "opencode",
      }],
    });
    assert.equal(text, "second API result");
    assert.deepEqual(requests, [
      { authorization: "Bearer first-secret", model: "first-model" },
      { authorization: "Bearer second-secret", model: "second-model" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible system AI calls the chat completions endpoint", async () => {
  let receivedPath = "";
  let authorization = "";
  let receivedBody: {
    model?: string;
    reasoning_effort?: string;
    stream?: boolean;
    messages?: Array<{ role?: string; content?: string }>;
  } = {};
  const server = createServer((req, res) => {
    receivedPath = req.url ?? "";
    authorization = req.headers.authorization ?? "";
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      receivedBody = JSON.parse(raw) as typeof receivedBody;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "generated message" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await callSystemAiText("prompt", {
      enabled: true,
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "api-secret",
      model: "gpt-5.3-codex-spark",
    });
    assert.equal(text, "generated message");
    assert.equal(receivedPath, "/v1/chat/completions");
    assert.equal(authorization, "Bearer api-secret");
    assert.equal(receivedBody.model, "gpt-5.3-codex-spark", "configured route model must be sent verbatim");
    assert.equal(receivedBody.reasoning_effort, "low");
    assert.equal(receivedBody.stream, false);
    assert.deepEqual(receivedBody.messages, [{ role: "user", content: "prompt" }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible system AI appends chat completions directly to versioned API roots", async () => {
  let receivedPath = "";
  const server = createServer((req, res) => {
    receivedPath = req.url ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "generated message" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await callSystemAiText("prompt", {
      enabled: true,
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/api/coding/paas/v4`,
      apiKey: "api-secret",
      model: "test-model",
    });
    assert.equal(text, "generated message");
    assert.equal(receivedPath, "/api/coding/paas/v4/chat/completions");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible system AI preserves x-api-key authentication", async () => {
  let apiKey = "";
  let authorization = "";
  const server = createServer((req, res) => {
    apiKey = String(req.headers["x-api-key"] ?? "");
    authorization = req.headers.authorization ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "generated message" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await callSystemAiText("prompt", {
      enabled: true,
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "openai-secret",
      model: "test-model",
      authHeader: "x-api-key",
    });
    assert.equal(text, "generated message");
    assert.equal(apiKey, "openai-secret");
    assert.equal(authorization, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Anthropic-compatible system AI preserves x-api-key authentication", async () => {
  let receivedPath = "";
  let apiKey = "";
  let authorization = "";
  const server = createServer((req, res) => {
    receivedPath = req.url ?? "";
    apiKey = String(req.headers["x-api-key"] ?? "");
    authorization = req.headers.authorization ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text: "generated message" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await callSystemAiText("prompt", {
      enabled: true,
      protocol: "anthropic",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "anthropic-secret",
      model: "test-model",
      authHeader: "x-api-key",
    });
    assert.equal(text, "generated message");
    assert.equal(receivedPath, "/v1/messages");
    assert.equal(apiKey, "anthropic-secret");
    assert.equal(authorization, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("system AI accepts complete OpenAI and Anthropic endpoint URLs", async () => {
  const receivedPaths: string[] = [];
  const server = createServer((req, res) => {
    receivedPaths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/messages")) {
      res.end(JSON.stringify({ content: [{ type: "text", text: "anthropic result" }] }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "openai result" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    assert.equal(await callSystemAiText("prompt", {
      enabled: true,
      protocol: "openai",
      baseUrl: `${origin}/gateway/v1/chat/completions?tenant=wand`,
      apiKey: "api-secret",
      model: "test-model",
    }), "openai result");
    assert.equal(await callSystemAiText("prompt", {
      enabled: true,
      protocol: "anthropic",
      baseUrl: `${origin}/gateway/v1/messages?tenant=wand`,
      apiKey: "api-secret",
      model: "test-model",
      authHeader: "x-api-key",
    }), "anthropic result");

    assert.deepEqual(receivedPaths, [
      "/gateway/v1/chat/completions?tenant=wand",
      "/gateway/v1/messages?tenant=wand",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("commit message generation uses the selected direct API", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "wand-direct-commit-"));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"message":"feat(commit): use direct API","tag":"v0.1.0"}' } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "wand-test@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Wand Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "before\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "chore: initialize fixture"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "after\n");

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await generateCommitMessageOnly(repo, "English", {
      systemAi: {
        enabled: true,
        protocol: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "direct-secret",
        model: "test-model",
      },
    });

    assert.equal(requests, 1);
    assert.deepEqual(result, { message: "feat(commit): use direct API", suggestedTag: "v0.1.0" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(repo, { recursive: true, force: true });
  }
});

test("direct API quick commit falls back to the selected CLI", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-direct-cli-fallback-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "cli-called");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > "$WAND_FALLBACK_MARKER"',
    "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fix: use CLI fallback\"}}'",
  ].join("\n"), { mode: 0o755 });

  const requests: Array<{ authorization: string; model: string }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization ?? "",
        model: (JSON.parse(raw) as { model?: string }).model ?? "",
      });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer first-secret") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "first unavailable" }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousPath = process.env.PATH;
  const previousMarker = process.env.WAND_FALLBACK_MARKER;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.WAND_FALLBACK_MARKER = marker;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "wand-test@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Wand Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "changed\n");

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await runQuickCommitWithFallback({
      cwd: repo,
      language: "English",
      provider: "codex",
      model: "current-session-model",
      thinkingEffort: "standard",
      systemAi: {
        enabled: true,
        protocol: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "first-secret",
        model: "gpt-5.3-codex-spark",
        fallbacks: [{
          enabled: true,
          protocol: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "second-secret",
          model: "second-api-model",
        }],
      },
      autoMessage: true,
    });

    assert.deepEqual(requests, [
      { authorization: "Bearer first-secret", model: "gpt-5.3-codex-spark" },
      { authorization: "Bearer second-secret", model: "second-api-model" },
    ]);
    assert.equal(result.commit.message, "fix: use CLI fallback");
    assert.equal(existsSync(marker), true);
    const cliArgs = readFileSync(marker, "utf8");
    assert.match(cliArgs, /--model\ncurrent-session-model\n/);
    assert.match(cliArgs, /-c\nmodel_reasoning_effort=low\n/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.WAND_FALLBACK_MARKER;
    else process.env.WAND_FALLBACK_MARKER = previousMarker;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed API and CLI fallback do not retry the selected CLI", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-ai-fallback-once-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "cli-calls");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), [
    "#!/bin/sh",
    'printf x >> "$WAND_FALLBACK_MARKER"',
    "exit 1",
  ].join("\n"), { mode: 0o755 });

  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousPath = process.env.PATH;
  const previousMarker = process.env.WAND_FALLBACK_MARKER;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.WAND_FALLBACK_MARKER = marker;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "wand-test@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Wand Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "changed\n");

    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      runQuickCommitWithFallback({
        cwd: repo,
        language: "English",
        provider: "codex",
        systemAi: {
          enabled: true,
          protocol: "openai",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "direct-secret",
          model: "test-model",
        },
        autoMessage: true,
      }),
      (error: unknown) => error instanceof QuickCommitError && error.code === "AI_FALLBACK_FAILED",
    );
    assert.equal(readFileSync(marker, "utf8"), "x");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.WAND_FALLBACK_MARKER;
    else process.env.WAND_FALLBACK_MARKER = previousMarker;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
