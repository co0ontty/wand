import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildClaudeCliArgs } from "../src/structured-claude-adapter.js";
import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import { applyGrokEvent, buildGrokArgs } from "../src/structured-grok-adapter.js";
import { buildCodexArgs } from "../src/structured-codex-adapter.js";
import { CodexProtocolReducer } from "../src/structured-codex-protocol.js";
import { applyOpenCodeEvent, buildOpenCodeArgs } from "../src/structured-opencode-adapter.js";
import { applyPiEvent, buildPiArgs } from "../src/structured-pi-adapter.js";
import { buildQoderArgs } from "../src/structured-qoder-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

const DIR = path.resolve("tests/fixtures/structured-cli-recordings");
const PROMPT = "Reply exactly WAND_MIGRATION_FIXTURE_OK. Do not use tools.";

type RecordedProvider = "codex" | "opencode" | "pi" | "qoder";
type MockProvider = "claude" | "grok";
interface Fixture {
  provider: RecordedProvider;
  scenario: "normal";
  args: string[];
  stdinData: string | null;
  events: Record<string, unknown>[];
  nonJsonLines: number;
  exitCode: number;
  signal: string | null;
}

function fixture(provider: RecordedProvider): Fixture {
  return JSON.parse(readFileSync(path.join(DIR, `${provider}-normal.json`), "utf8")) as Fixture;
}

function session(provider: RecordedProvider | MockProvider): SessionSnapshot {
  return {
    id: "fixture-session", sessionKind: "structured", provider,
    runner: "fixture", command: "fixture", cwd: "/fixture", mode: "default",
    status: "idle", exitCode: null, startedAt: new Date(0).toISOString(),
    endedAt: null, output: "", archived: false, archivedAt: null,
  };
}

for (const provider of ["codex", "opencode", "pi", "qoder"] as const) {
  test(`S0 recorded ${provider} protocol is scrubbed and uses production argv`, () => {
    const recorded = fixture(provider);
    assert.equal(recorded.provider, provider);
    assert.equal(recorded.scenario, "normal");
    assert.equal(recorded.exitCode, 0);
    assert.equal(recorded.signal, null);
    assert.equal(recorded.nonJsonLines, 0);
    assert.ok(recorded.events.length > 0);
    assert.ok(recorded.events.every((event) => typeof event.type === "string"));
    const configured = session(provider);
    if (provider === "qoder") configured.selectedModel = "Qwen3.8-Flash";
    const expectedArgs = provider === "codex" ? buildCodexArgs(configured)
      : provider === "opencode" ? buildOpenCodeArgs(configured)
        : provider === "qoder" ? buildQoderArgs(configured, PROMPT)
          : buildPiArgs(configured, PROMPT);
    assert.deepEqual(recorded.args, expectedArgs.map((arg) => arg === PROMPT ? "<FIXTURE_PROMPT>" : arg));
    assert.equal(recorded.stdinData, provider === "pi" || provider === "qoder" ? null : "<FIXTURE_PROMPT>");
    const serialized = JSON.stringify(recorded);
    assert.ok(!serialized.includes(PROMPT));
    assert.doesNotMatch(serialized, /(?:https?:\/\/|\/Users\/|\/home\/|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i);
    assert.doesNotMatch(serialized, /(?:sk-[\w-]{16,}|(?:api[_-]?key|authorization|password|cookie)"\s*:)/i);
  });
}

test("S0 real Codex stream reduces to the stable session and text projection", () => {
  const reducer = new CodexProtocolReducer(session("codex"));
  for (const event of fixture("codex").events) reducer.apply(event);
  assert.equal(reducer.state.sessionId, "fixture-id-1");
  assert.equal(reducer.state.result, "FIXTURE_TEXT");
  assert.equal(reducer.primaryError, null);
});

test("S0 Qoder Qwen3.8-Flash stream reduces with the Claude-shaped protocol", () => {
  const reducer = new ClaudeCliProtocolReducer(session("qoder"));
  for (const event of fixture("qoder").events) reducer.apply(event, false);
  assert.equal(reducer.state.sessionId, "fixture-id-1");
  assert.equal(reducer.state.result, "FIXTURE_TEXT");
  assert.ok(reducer.state.blocks.some((block) => block.type === "text"));
});

test("S0 mock Claude stream covers resume, question, tool result and completion", () => {
  const mocked = JSON.parse(readFileSync(path.join(DIR, "claude-mock.json"), "utf8")) as {
    scenario: string; source: string; args: string[]; events: Record<string, unknown>[];
  };
  assert.equal(mocked.scenario, "synthetic-mock");
  assert.equal(mocked.source, "handwritten-from-node-adapter-contract");
  const configured = { ...session("claude"), claudeSessionId: "fixture-session-id" };
  assert.deepEqual(mocked.args, buildClaudeCliArgs(configured, {
    permissionPolicy: { permissionMode: "default", allowedTools: undefined },
  }));
  const reducer = new ClaudeCliProtocolReducer(configured);
  for (const event of mocked.events) reducer.apply(event, false);
  assert.equal(reducer.state.result, "FIXTURE_TEXT");
  assert.equal(reducer.state.sessionId, "fixture-session-id");
  assert.equal(reducer.askUserQuestionDetected, true);
  assert.ok(reducer.state.blocks.some((block) => block.type === "tool_result"));
});

test("S0 mock Grok stream covers argv, tools, text and terminal usage", () => {
  const mocked = JSON.parse(readFileSync(path.join(DIR, "grok-mock.json"), "utf8")) as {
    scenario: string; source: string; args: string[]; events: Record<string, unknown>[];
  };
  assert.equal(mocked.scenario, "synthetic-mock");
  assert.equal(mocked.source, "handwritten-from-node-adapter-contract");
  const configured = { ...session("grok"), claudeSessionId: "fixture-session-id" };
  const expected = buildGrokArgs(configured, PROMPT).map((arg) => arg === PROMPT ? "<FIXTURE_PROMPT>" : arg);
  assert.deepEqual(mocked.args, expected);
  const state = { blocks: [], result: "", sessionId: null };
  for (const event of mocked.events) assert.equal(applyGrokEvent(state, event), null);
  assert.equal(state.result, "FIXTURE_TEXT");
  assert.equal(state.sessionId, "fixture-session-id");
  assert.ok(state.blocks.some((block) => block.type === "tool_result"));
  assert.equal(applyGrokEvent(state, { type: "error", message: "mock failure" }), "mock failure");
});

test("S0 real OpenCode and Pi streams reach a terminal text projection", () => {
  const state = { blocks: [], result: "", sessionId: null };
  for (const event of fixture("opencode").events) applyOpenCodeEvent(state, event);
  assert.equal(state.sessionId, "fixture-id-1");
  assert.equal(state.result, "FIXTURE_TEXT");

  const piState = { blocks: [], result: "", sessionId: null };
  for (const event of fixture("pi").events) applyPiEvent(piState, event);
  assert.equal(piState.sessionId, "fixture-id-1");
  assert.ok(piState.result.includes("FIXTURE_TEXT"));
});
