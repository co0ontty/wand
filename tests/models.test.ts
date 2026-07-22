import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CATALOG_CACHE_KEY,
  ModelCatalogService,
  ModelCommandRunner,
  ModelRefreshOptions,
  parseCodexModels,
  parseGrokModels,
  parseOpenCodeModels,
  parseQoderModels,
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
    if (file === "grok") throw new Error("not installed");
    if (file === "qodercli") throw new Error("not installed");
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

test("Grok model discovery parses default and available models", () => {
  const models = parseGrokModels([
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.5",
    "",
    "Available models:",
    "  * grok-4.5 (default)",
    "  * grok-3",
  ].join("\n"));

  assert.deepEqual(models.map((model) => model.id), ["default", "grok-4.5", "grok-3"]);
  assert.equal(models[0]?.alias, true);
  assert.equal(models[0]?.label, "grok-4.5（Grok 默认）");
});

test("Grok model discovery falls back when output is empty", () => {
  const models = parseGrokModels("not a model list");
  assert.equal(models[0]?.id, "default");
  assert.equal(models.some((model) => model.id === "grok-4.5"), true);
});

test("Qoder model catalog exposes the official tier aliases", async () => {
  const result = await refreshModels(refreshOptions());
  assert.deepEqual(result.qoderModels.map((model) => model.id), [
    "default", "lite", "efficient", "auto", "performance", "ultimate",
  ]);
});

test("Qoder model discovery accepts bare and provider-qualified IDs", () => {
  const models = parseQoderModels([
    "outside-list-id",
    "\x1b[1mMODEL\x1b[0m",
    "GLM-5.2 (Z.ai) (zhipu/glm5.2-cp)",
    "Claude Sonnet 4.6 (claude-sonnet-4-6)",
    "glm51",
    "GLM-5.2 duplicate (zhipu/glm5.2-cp)",
    "Unsafe (model;rm-rf)",
  ].join("\n"));

  assert.deepEqual(models.map((model) => model.id), [
    "default", "lite", "efficient", "auto", "performance", "ultimate",
    "zhipu/glm5.2-cp", "claude-sonnet-4-6", "glm51",
  ]);
  assert.equal(models.find((model) => model.id === "zhipu/glm5.2-cp")?.label, "GLM-5.2 (Z.ai)");
  assert.equal(models.find((model) => model.id === "claude-sonnet-4-6")?.label, "Claude Sonnet 4.6");
  assert.equal(models.some((model) => model.id === "outside-list-id"), false);
  assert.equal(models.some((model) => model.id === "model;rm-rf"), false);
});

test("server model catalog persists every provider and writes only when its content changes", async () => {
  const storage = new FakeModelStorage();
  let now = new Date("2026-07-14T12:00:00.000Z");
  let qoderOutput = ["MODEL", "Frontier (qoder-frontier-1)"].join("\n");
  const runner: ModelCommandRunner = async (file, args) => {
    if (file === "claude" && args.join(" ") === "--version") return { stdout: "2.1.149\n", stderr: "" };
    if (file === "codex" && args.join(" ") === "debug models") {
      return { stdout: JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list", priority: 0 }] }), stderr: "" };
    }
    if (file === "opencode" && args.join(" ") === "models") return { stdout: "openai/gpt-5.4\n", stderr: "" };
    if (file === "opencode" && args.join(" ") === "--version") return { stdout: "1.2.3\n", stderr: "" };
    if (file === "grok" && args.join(" ") === "models") return { stdout: "Default model: grok-4.5\n* grok-4.5\n* grok-3", stderr: "" };
    if (file === "qodercli" && args.join(" ") === "--list-models") return { stdout: qoderOutput, stderr: "" };
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  };
  const options = (): ModelRefreshOptions => ({ env: {}, storage, commandRunner: runner, now: () => now });
  const catalog = new ModelCatalogService(options);

  const first = await catalog.refresh();
  assert.equal(first.changed, true);
  assert.deepEqual(first.codexModels.map((model) => model.id), ["default", "gpt-5.5"]);
  assert.deepEqual(first.opencodeModels.map((model) => model.id), ["default", "openai/gpt-5.4"]);
  assert.deepEqual(first.grokModels.map((model) => model.id), ["default", "grok-4.5", "grok-3"]);
  assert.equal(first.qoderModels.some((model) => model.id === "qoder-frontier-1"), true);
  const firstRaw = storage.getRaw(MODEL_CATALOG_CACHE_KEY);
  assert.ok(firstRaw);

  now = new Date("2026-07-14T13:00:00.000Z");
  const unchanged = await catalog.refresh();
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.refreshedAt, first.refreshedAt);
  assert.equal(storage.getRaw(MODEL_CATALOG_CACHE_KEY), firstRaw);

  qoderOutput = ["MODEL", "Frontier (qoder-frontier-2)"].join("\n");
  now = new Date("2026-07-14T14:00:00.000Z");
  const changed = await catalog.refresh();
  assert.equal(changed.changed, true);
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.qoderModels.some((model) => model.id === "qoder-frontier-2"), true);
  assert.notEqual(storage.getRaw(MODEL_CATALOG_CACHE_KEY), firstRaw);

  // A new server instance serves its persisted model directory immediately;
  // transient CLI outages do not replace it with fallback values.
  const unavailable: ModelCommandRunner = async () => { throw new Error("CLI unavailable"); };
  const reloaded = new ModelCatalogService(() => ({ ...options(), commandRunner: unavailable }));
  assert.equal(reloaded.snapshot().qoderModels.some((model) => model.id === "qoder-frontier-2"), true);
  const retained = await reloaded.refresh();
  assert.equal(retained.changed, false);
  assert.equal(retained.qoderModels.some((model) => model.id === "qoder-frontier-2"), true);
});

test("server model catalog coalesces concurrent refreshes", async () => {
  const storage = new FakeModelStorage();
  let calls = 0;
  let releaseProbe: (() => void) | undefined;
  const qoderProbeStarted = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let allowQoder: (() => void) | undefined;
  const qoderGate = new Promise<void>((resolve) => {
    allowQoder = resolve;
  });
  const runner: ModelCommandRunner = async (file, args) => {
    calls += 1;
    if (file === "qodercli") {
      releaseProbe?.();
      await qoderGate;
      return { stdout: "MODEL\nFrontier (qoder-frontier-1)", stderr: "" };
    }
    if (file === "claude") return { stdout: "2.1.149\n", stderr: "" };
    if (file === "codex") return { stdout: "{}", stderr: "" };
    if (file === "opencode" && args[0] === "models") return { stdout: "", stderr: "" };
    if (file === "opencode") return { stdout: "1.2.3\n", stderr: "" };
    if (file === "grok") return { stdout: "", stderr: "" };
    throw new Error(`Unexpected command: ${file}`);
  };
  const catalog = new ModelCatalogService(() => ({ env: {}, storage, commandRunner: runner }));
  const first = catalog.refresh();
  await qoderProbeStarted;
  const second = catalog.refresh();
  allowQoder?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.revision, secondResult.revision);
  // claude, codex, opencode models/version, grok, qoder: one server scan.
  assert.equal(calls, 6);
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
