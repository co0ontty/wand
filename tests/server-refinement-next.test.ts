import assert from "node:assert/strict";
import test from "node:test";
import { parseTimestampMs } from "../src/time-utils.js";
import { wrapLegacyTaskLayout } from "../src/layout-tree.js";
import { sanitizeTaskLayout } from "../src/server-workspace-routes.js";
import { mapWorkspaceTaskLayout } from "../src/storage/mappers.js";
import { fallbackProviderModel, readProviderModelPreferences } from "../src/session-model.js";
import { PROVIDER_MODEL_PREFERENCE_FIELDS } from "../src/config.js";
import { SESSION_PROVIDERS } from "../src/session-provider.js";
import { buildStructuredCliResult, classifyStructuredFailure } from "../src/structured-failure.js";
import { emitToSubscribedListeners, subscribeWithBufferedEvents, subscribeWithPendingEvent } from "../src/daemon-connection.js";
import type { LayoutNode, WandConfig } from "../src/types.js";
import type { StructuredRunnerTurnState } from "../src/structured-runner.js";

test("retained exit delivery is deferred and disposal cancels the queued callback", async () => {
  const listeners = new Set<(event: { exitCode: number }) => void>();
  const exit = { exitCode: 0 };
  const delivered: unknown[] = [];
  const subscribed = subscribeWithPendingEvent(listeners, (event) => delivered.push(event), exit);
  const cancelled = subscribeWithPendingEvent(listeners, (event) => delivered.push(event), exit);
  assert.deepEqual(delivered, [], "retained exits do not fire synchronously during subscription");
  cancelled.dispose();
  await Promise.resolve();
  assert.deepEqual(delivered, [exit]);
  assert.equal(delivered[0], exit);
  subscribed.dispose();
  subscribed.dispose();
  assert.equal(listeners.size, 0);
});

test("subscriptions with no retained exit receive only the owner's live events", async () => {
  const listeners = new Set<(event: { exitCode: number }) => void>();
  const delivered: number[] = [];
  const subscription = subscribeWithPendingEvent(listeners, (event) => delivered.push(event.exitCode), null);
  await Promise.resolve();
  assert.deepEqual(delivered, []);
  for (const listener of listeners) listener({ exitCode: 1 });
  assert.deepEqual(delivered, [1]);
  subscription.dispose();
  for (const listener of listeners) listener({ exitCode: 2 });
  assert.deepEqual(delivered, [1]);
});

test("buffered subscription replays the batch once in order and disposal cancels before delivery", async () => {
  const listeners = new Set<(event: number) => void>();
  const first: number[] = [], second: number[] = [];
  const subscription = subscribeWithBufferedEvents(listeners, (event) => first.push(event), [1, 2, 3]);
  const cancelled = subscribeWithBufferedEvents(listeners, (event) => second.push(event), [4, 5]);
  cancelled.dispose();
  assert.deepEqual(first, []);
  await Promise.resolve();
  assert.deepEqual(first, [1, 2, 3]);
  assert.deepEqual(second, []);
  subscription.dispose();
  assert.equal(listeners.size, 0);
});

test("live listener delivery preserves its snapshot under re-entrant removal and addition", () => {
  const listeners = new Set<(event: number) => void>();
  const delivered: string[] = [];
  assert.equal(emitToSubscribedListeners(listeners, 1), false, "owner should buffer when no listener exists");
  const next = () => delivered.push("next");
  const removed = () => delivered.push("removed");
  listeners.add(() => { delivered.push("first"); listeners.delete(removed); listeners.add(next); });
  listeners.add(removed);
  assert.equal(emitToSubscribedListeners(listeners, 1), true);
  assert.deepEqual(delivered, ["first", "removed"], "current delivery retains its original snapshot");
  delivered.length = 0;
  assert.equal(emitToSubscribedListeners(listeners, 2), true);
  assert.deepEqual(delivered, ["first", "next"]);
});

test("live delivery preserves listener exceptions instead of silently buffering accepted data", () => {
  const failure = new Error("listener failed");
  const listeners = new Set<((event: number) => void)>([() => { throw failure; }]);
  assert.throws(() => emitToSubscribedListeners(listeners, 1), (error) => error === failure);
});

test("nullable timestamps retain invalid/missing distinction, epoch zero and timezone offsets", () => {
  for (const value of [null, undefined, "", "bad-date"]) assert.equal(parseTimestampMs(value), null);
  assert.equal(parseTimestampMs("1970-01-01T00:00:00Z"), 0);
  assert.equal(parseTimestampMs("2026-10-13T07:00:00Z"), parseTimestampMs("2026-10-13T15:00:00+08:00"));
});

test("legacy layout wrapper preserves its tree and active selection through both public entrypoints", () => {
  const tree: LayoutNode = { type: "split", dir: "h", ratio: 0.5, children: [
    { type: "pane", tabs: [{ id: "tab1", kind: "session", sessionId: "session1" }, { id: "tab2", kind: "session", sessionId: "session2" }], active: 1 },
    { type: "pane", tabs: [{ id: "tab3", kind: "session", sessionId: "session3" }], active: 0 },
  ] };
  const expected = wrapLegacyTaskLayout(tree);
  assert.equal(expected.windows[0]!.layout, tree, "wrapping does not rewrite the original tree");
  assert.equal(expected.windows[0]!.activeTabId, "tab2");
  assert.equal(expected.activeWindowId, "window-legacy");
  assert.deepEqual(sanitizeTaskLayout(tree), expected);
  assert.deepEqual(mapWorkspaceTaskLayout(JSON.stringify(tree)), expected);
});

test("layout read compatibility remains distinct from HTTP write sanitization", () => {
  const malformedWindows = { type: "windows", windows: [{ id: "", layout: {} }], activeWindowId: "missing" };
  assert.deepEqual(mapWorkspaceTaskLayout(JSON.stringify(malformedWindows)), malformedWindows);
  assert.deepEqual(sanitizeTaskLayout(malformedWindows), { type: "windows", windows: [], activeWindowId: null });
  assert.equal(mapWorkspaceTaskLayout("not-json"), null);
  assert.equal(sanitizeTaskLayout(null), null);
});

test("live default-model preferences use the canonical provider mapping and retain raw values", () => {
  const config = {} as WandConfig;
  const values = new Map<string, string>();
  const calls: string[] = [];
  const store = { getPreference<T>(key: string, fallback: T): T {
    calls.push(key);
    return values.has(key) ? values.get(key) as T : fallback;
  } };
  for (const provider of SESSION_PROVIDERS) config[PROVIDER_MODEL_PREFERENCE_FIELDS[provider]] = `${provider}-fallback`;
  values.set("pref:defaultModel", "  default  ");
  values.set("pref:defaultPiModel", "");
  const first = readProviderModelPreferences(config, store);
  assert.equal(first.claude, "  default  ", "catalog reads do not apply trim/default normalization");
  assert.equal(first.pi, "", "explicit empty preference wins over configured fallback");
  for (const provider of SESSION_PROVIDERS.filter((value) => value !== "claude" && value !== "pi")) {
    assert.equal(first[provider], `${provider}-fallback`);
  }
  assert.deepEqual(calls, SESSION_PROVIDERS.map((provider) => `pref:${PROVIDER_MODEL_PREFERENCE_FIELDS[provider]}`));
  values.set("pref:defaultPiModel", "live-pi-model");
  config.defaultCodexModel = "changed-config";
  assert.equal(readProviderModelPreferences(config, store).pi, "live-pi-model");
  assert.equal(readProviderModelPreferences(config, store).codex, "changed-config");
});

test("provider fallback resolves its configured default only once per synchronous selection", () => {
  let reads = 0;
  const config = { modelGroups: [], get defaultModel() { reads++; return "  configured  "; } } as unknown as WandConfig;
  assert.equal(fallbackProviderModel(config, "claude"), "configured");
  assert.equal(reads, 1, "fallback does not rebuild the seven-provider default projection twice");
  assert.equal(fallbackProviderModel({ modelGroups: [], defaultModel: "default" } as unknown as WandConfig, "claude"), undefined);
});

const blank = (): StructuredRunnerTurnState => ({ blocks: [], result: "", sessionId: null });
test("CLI exit builder retains identities and does not leak internal parsing observations", () => {
  const state = blank();
  const success = buildStructuredCliResult({ state, exitCode: 0, signal: null, stderr: "", primaryError: null,
    protocolError: false, unparsedStdout: false });
  assert.equal(success.state, state);
  assert.equal("spawnError" in success, false);
  assert.equal("protocolError" in success, false);
  assert.equal("unparsedStdout" in success, false);
  assert.equal("inputAccepted" in success, false);
  assert.equal(classifyStructuredFailure(success), null);
  const error = Object.assign(new Error("missing executable"), { code: "ENOENT" });
  const failed = buildStructuredCliResult({ state, exitCode: null, signal: null, stderr: "diagnostic", primaryError: null,
    spawnError: error, protocolError: false, unparsedStdout: false });
  assert.equal(failed.spawnError, error);
  assert.equal(failed.stderr, "diagnostic");
  assert.equal(classifyStructuredFailure(failed)?.delivery, "rejected");
});

test("shared CLI finalization permits only explicit pre-execution refusals to claim no delivery", () => {
  const refused = { state: blank(), exitCode: 1, signal: null, stderr: "", primaryError: "invalid api key",
    protocolError: true, unparsedStdout: false } as const;
  const result = buildStructuredCliResult(refused);
  assert.equal(result.inputAccepted, false);
  assert.equal(result.rejection, "authentication");
  assert.equal(classifyStructuredFailure(result)?.retryable, true);
  for (const input of [
    { ...refused, protocolError: false },
    { ...refused, unparsedStdout: true },
    { ...refused, signal: "SIGTERM" as const },
    { ...refused, state: { ...blank(), result: "already worked" } },
    { ...refused, state: { ...blank(), usage: { inputTokens: 1 } } },
    { ...refused, spawnError: new Error("spawn error") },
  ]) {
    assert.equal("inputAccepted" in buildStructuredCliResult(input), false);
    assert.equal("rejection" in buildStructuredCliResult(input), false);
  }
});
