import assert from "node:assert/strict";
import test from "node:test";
import { computeRunningSignal, formatElapsedShort } from "../src/web-ui/session-activity.js";
import { deriveLegacyUiSnapshot } from "../src/web-ui/react/shell/legacy-snapshot.js";

const inactive = { active: false, inFlight: false, ptyRunning: false, permissionBlocked: false };

test("empty and archived sessions have complete false activity flags", () => {
  assert.deepEqual(computeRunningSignal(undefined), inactive);
  assert.deepEqual(computeRunningSignal(null), inactive);
  assert.deepEqual(computeRunningSignal({ archived: true, permissionBlocked: true, structuredState: { inFlight: true } }), inactive);
});

test("PTY activity distinguishes live provider turns from retained shells", () => {
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi"]) {
    assert.equal(computeRunningSignal({ status: "running", provider }).active, false);
    assert.equal(computeRunningSignal({ status: "running", provider, ptyBusy: true }).active, true);
    assert.equal(computeRunningSignal({ status: "running", provider, ptyBusy: true, providerCliActive: false }).active, false);
  }
  assert.equal(computeRunningSignal({ status: "running" }).ptyRunning, true);
  assert.equal(computeRunningSignal({ status: "exited", ptyBusy: true }).active, false);
});

test("structured responding and permission waits have separate activity flags", () => {
  assert.deepEqual(computeRunningSignal({ sessionKind: "structured", status: "running", structuredState: { inFlight: false } }), inactive);
  assert.deepEqual(computeRunningSignal({ sessionKind: "structured", structuredState: { inFlight: true } }), {
    active: true, inFlight: true, ptyRunning: false, permissionBlocked: false,
  });
  assert.deepEqual(computeRunningSignal({ permissionBlocked: true }), {
    active: true, inFlight: false, ptyRunning: false, permissionBlocked: true,
  });
  assert.equal(computeRunningSignal({ runner: "claude-cli-print", structuredState: { inFlight: true } }).inFlight, true);
});

test("React snapshot and composer controls agree on turn activity", () => {
  const environment = { width: 1440, online: true, embedTerminal: false, nativeInput: false, backToNative: false, switchServer: false };
  for (const session of [
    { id: "a", status: "running", provider: "claude", ptyBusy: true, providerCliActive: false },
    { id: "a", status: "running", provider: "pi", ptyBusy: true },
    { id: "a", status: "running" },
    { id: "a", archived: true, permissionBlocked: true },
    { id: "a", sessionKind: "structured", structuredState: { inFlight: true } },
  ]) {
    const expected = computeRunningSignal(session);
    const snapshot = deriveLegacyUiSnapshot({ sessions: [session], selectedId: "a" }, environment);
    assert.equal(snapshot.selected?.turnActive, expected.inFlight || expected.ptyRunning);
    assert.equal(snapshot.selected?.permissionBlocked, expected.permissionBlocked);
    assert.equal(snapshot.selected?.inFlight, expected.inFlight);
  }
});

test("elapsed labels preserve minute and hour boundaries", () => {
  assert.equal(formatElapsedShort(-100), "0s");
  assert.equal(formatElapsedShort(59_999), "59s");
  assert.equal(formatElapsedShort(60_000), "1m");
  assert.equal(formatElapsedShort(61_000), "1m 1s");
  assert.equal(formatElapsedShort(3_660_000), "1h 1m");
});
