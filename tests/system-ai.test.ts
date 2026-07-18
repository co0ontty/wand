import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateCommitMessageOnly, QuickCommitError, runQuickCommitWithFallback } from "../src/git-quick-commit.js";
import { callSystemAiText, callSystemAiTextWithFallback, discoverCliSystemAiConfig, discoverCliSystemAiConfigs } from "../src/system-ai.js";

test("CLI discovery copies Claude API settings without mutating the source", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wand-system-ai-"));
  try {
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://proxy.example", ANTHROPIC_AUTH_TOKEN: "secret-token" },
      model: "custom-model",
    }));
    const found = discoverCliSystemAiConfig("claude", home);
    assert.deepEqual(found, {
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

test("system AI tries configured APIs in order until one returns text", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.headers.authorization}:${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization === "Bearer first-secret") {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: "unavailable" }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "second API result" } }] }));
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
    assert.deepEqual(requests.map((request) => request.split(":", 1)[0]), ["Bearer first-secret", "Bearer second-secret"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible system AI calls the chat completions endpoint", async () => {
  let receivedPath = "";
  let authorization = "";
  const server = createServer((req, res) => {
    receivedPath = req.url ?? "";
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
      apiKey: "api-secret",
      model: "test-model",
    });
    assert.equal(text, "generated message");
    assert.equal(receivedPath, "/v1/chat/completions");
    assert.equal(authorization, "Bearer api-secret");
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
    ': > "$WAND_FALLBACK_MARKER"',
    "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"fix: use CLI fallback\"}}'",
  ].join("\n"), { mode: 0o755 });

  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
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
    const result = await runQuickCommitWithFallback({
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
    });

    assert.equal(requests, 1);
    assert.equal(result.commit.message, "fix: use CLI fallback");
    assert.equal(existsSync(marker), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.WAND_FALLBACK_MARKER;
    else process.env.WAND_FALLBACK_MARKER = previousMarker;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI quick commit falls back to a configured direct API", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-api-fallback-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const marker = path.join(root, "cli-called");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(path.join(bin, "codex"), [
    "#!/bin/sh",
    ': > "$WAND_FALLBACK_MARKER"',
    "echo 'CLI unavailable' >&2",
    "exit 1",
  ].join("\n"), { mode: 0o755 });

  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "fix: use API fallback" } }] }));
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
      fallbackSystemAi: {
        enabled: true,
        protocol: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "direct-secret",
        model: "test-model",
      },
      autoMessage: true,
    });

    assert.equal(requests, 1);
    assert.equal(result.commit.message, "fix: use API fallback");
    assert.equal(existsSync(marker), true);
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
