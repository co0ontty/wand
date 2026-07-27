import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { RuntimeConfigState } from "../src/runtime-config.js";

test("RuntimeConfigState keeps deployment changes desired-only and applies hot preferences", () => {
  const active = { ...defaultConfig(), host: "127.0.0.1", port: 8443, defaultProvider: "claude" as const };
  const state = new RuntimeConfigState(active);
  const candidate = state.createCandidate();
  candidate.host = "0.0.0.0";
  candidate.port = 9443;
  candidate.defaultProvider = "codex";

  state.commit(candidate, ["defaultProvider"]);

  assert.equal(active.host, "127.0.0.1");
  assert.equal(active.port, 8443);
  assert.equal(active.defaultProvider, "codex");
  assert.deepEqual(state.activeDeployment(), {
    host: "127.0.0.1",
    port: 8443,
    https: false,
    shell: active.shell,
  });
  assert.equal(state.desiredDeployment().host, "0.0.0.0");
  assert.equal(state.hasPendingRestart(), true);
});

test("RuntimeConfigState snapshots are isolated from callers", () => {
  const active = defaultConfig();
  const state = new RuntimeConfigState(active);
  const candidate = state.createCandidate();
  candidate.cardDefaults.editCards = !candidate.cardDefaults.editCards;

  assert.notEqual(candidate.cardDefaults.editCards, state.desiredSnapshot().cardDefaults.editCards);
  assert.notEqual(candidate.cardDefaults.editCards, active.cardDefaults.editCards);
});
