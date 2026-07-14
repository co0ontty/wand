import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelCommandRunner,
  ModelRefreshOptions,
  parseCodexModels,
  parseOpenCodeModels,
  refreshModels,
} from "../src/models.js";

class FakeModelStorage {
  private readonly values = new Map<string, string>();

  getConfigValue(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.values.set(key, value);
  }

  getRaw(key: string): string | undefined {
    return this.values.get(key);
  }
}

function createCommandRunner(
  overrides: Record<string, { stdout?: string; reject?: boolean }> = {},
): ModelCommandRunner {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    const override = overrides[key];
    if (override?.reject) throw new Error("probe failed");
    if (override) return { stdout: override.stdout ?? "", stderr: "" };
    if (file === "claude" && args[0] === "--version") return { stdout: "2.1.149\n", stderr: "" };
    if (file === "codex") throw new Error("not installed");
    if (file === "opencode") throw new Error("not installed");
    throw new Error(`Unexpected command: ${key}`);
  };
}

function onePage<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      yield* items;
    },
  };
}

function refreshOptions(overrides: Partial<ModelRefreshOptions> = {}): ModelRefreshOptions {
  return {
    env: {},
    commandRunner: createCommandRunner(),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    ...overrides,
  };
}

test("Codex model discovery preserves per-model reasoning levels", () => {
  const models = parseCodexModels(JSON.stringify({
    models: [
      {
        slug: "gpt-new",
        display_name: "GPT New",
        visibility: "list",
        priority: 0,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast" },
          { effort: "medium", description: "Balanced" },
          { effort: "ultra", description: "Deepest" },
        ],
      },
      {
        slug: "hidden",
        visibility: "hide",
        supported_reasoning_levels: [{ effort: "high" }],
      },
    ],
  }));

  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    id: "default",
    label: "GPT New · gpt-new（Codex 默认）",
    alias: true,
    reasoningEfforts: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
      { effort: "ultra", description: "Deepest" },
    ],
    defaultReasoningEffort: "medium",
  });
  assert.deepEqual(models[1]?.reasoningEfforts?.map((level) => level.effort), ["low", "medium", "ultra"]);
});

test("Codex model discovery falls back when output is invalid", () => {
  const models = parseCodexModels("not json");
  assert.equal(models[0]?.id, "default");
  assert.equal(models[0]?.alias, true);
});

test("OpenCode model discovery parses provider/model lines and removes duplicates", () => {
  const models = parseOpenCodeModels([
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.4",
    "anthropic/claude-sonnet-4-6",
    "diagnostic noise",
  ].join("\n"));

  assert.deepEqual(models.map((model) => model.id), [
    "default",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.4",
  ]);
  assert.equal(models[0]?.alias, true);
});

test("OpenCode model discovery falls back when no model ids are present", () => {
  const models = parseOpenCodeModels("old opencode output");
  assert.deepEqual(models.map((model) => model.id), ["default"]);
});

test("Claude candidates merge configured, verified, and Models API entries without asserting entitlement", async () => {
  const storage = new FakeModelStorage();
  const models = await refreshModels(refreshOptions({
    storage,
    configuredClaudeModels: ["claude-local-9", "claude-api-1"],
    apiKey: "test-key",
    modelsApi: {
      list: () => onePage([
        { id: "claude-api-1", display_name: "API One" },
        { id: "claude-api-2", display_name: "API Two" },
        { id: "not valid model id" },
      ]),
    },
  }));

  assert.deepEqual(models.models.map((model) => model.id), [
    "default",
    "opus",
    "sonnet",
    "haiku",
    "claude-api-1",
    "claude-api-2",
    "claude-local-9",
  ]);
  const apiCandidate = models.models.find((model) => model.id === "claude-api-2");
  assert.equal(apiCandidate?.label, "API Two · claude-api-2");
  assert.equal(apiCandidate?.source, "models-api");
  assert.equal(apiCandidate?.availability, "candidate");
  assert.equal(apiCandidate?.lastVerifiedAt, undefined);
  assert.equal(models.models.find((model) => model.id === "claude-api-1")?.source, "configured");
});

test("only successful Claude CLI probes persist and mark model verification", async () => {
  const storage = new FakeModelStorage();
  const commandRunner = createCommandRunner({
    "claude --model claude-good -p Reply with exactly: ok": { stdout: "ok\n" },
    "claude --model claude-bad -p Reply with exactly: ok": { reject: true },
    "claude --model opus -p Reply with exactly: ok": { reject: true },
    "claude --model sonnet -p Reply with exactly: ok": { reject: true },
    "claude --model haiku -p Reply with exactly: ok": { reject: true },
  });
  const models = await refreshModels(refreshOptions({
    storage,
    commandRunner,
    configuredClaudeModels: ["claude-good", "claude-bad"],
    verifyClaudeCandidates: true,
  }));

  const good = models.models.find((model) => model.id === "claude-good");
  const bad = models.models.find((model) => model.id === "claude-bad");
  assert.equal(good?.availability, "verified");
  assert.equal(good?.lastVerifiedAt, "2026-07-14T12:00:00.000Z");
  assert.equal(good?.verifiedWithClaudeVersion, "2.1.149");
  assert.equal(bad?.availability, "candidate");

  const persisted = JSON.parse(storage.getRaw("claude-model-verifications-v1") ?? "{}") as { models?: Array<{ id: string }> };
  assert.deepEqual(persisted.models?.map((model) => model.id), ["claude-good"]);
});

test("old verification timestamps and changed Claude versions remain visible but stale", async () => {
  const storage = new FakeModelStorage();
  storage.setConfigValue("claude-model-verifications-v1", JSON.stringify({
    version: 1,
    models: [{
      id: "claude-old",
      label: "Old Claude",
      verifiedAt: "2026-06-01T12:00:00.000Z",
      claudeVersion: "2.1.100",
    }],
  }));
  const models = await refreshModels(refreshOptions({ storage }));
  const old = models.models.find((model) => model.id === "claude-old");
  assert.equal(old?.availability, "stale");
  assert.equal(old?.lastVerifiedAt, "2026-06-01T12:00:00.000Z");
  assert.equal(old?.verifiedWithClaudeVersion, "2.1.100");
});

test("failed model API discovery leaves configured candidates usable and never writes verification", async () => {
  const storage = new FakeModelStorage();
  const models = await refreshModels(refreshOptions({
    storage,
    configuredClaudeModels: ["claude-custom"],
    apiKey: "test-key",
    modelsApi: {
      list: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<{ id: string }> {
          throw new Error("network unavailable");
        },
      }),
    },
  }));

  const custom = models.models.find((model) => model.id === "claude-custom");
  assert.equal(custom?.availability, "candidate");
  assert.equal(storage.getRaw("claude-model-verifications-v1"), undefined);
});
