import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexModels } from "../src/models.js";

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
