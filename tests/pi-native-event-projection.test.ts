import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import nativeBridge from "../src/pi-native-event-bridge.js";

test("native bridge journals only new protocol output, including all terminal boundaries", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-source-projection-"));
  const events = path.join(root, "events.jsonl");
  const paths = path.join(root, "paths.json");
  writeFileSync(paths, JSON.stringify({ events, ready: path.join(root, "ready.json") }));
  const previous = process.env.WAND_PI_NATIVE_PATHS;
  process.env.WAND_PI_NATIVE_PATHS = paths;
  t.after(() => { if (previous === undefined) delete process.env.WAND_PI_NATIVE_PATHS;
    else process.env.WAND_PI_NATIVE_PATHS = previous; rmSync(root, { recursive: true, force: true }); });
  const callbacks = new Map<string, (event: unknown, ctx?: unknown) => void>();
  nativeBridge({ on(name: string, callback: (event: unknown) => void) { callbacks.set(name, callback); } } as unknown as ExtensionAPI);
  const large = "x".repeat(9 * 1024 * 1024);
  const assistant = { role: "assistant", stopReason: "error", errorMessage: "terminal error", content: [] };
  callbacks.get("turn_end")!({ type: "turn_end", message: assistant, context: { messages: large }, toolResults: [large], entries: [large] });
  callbacks.get("agent_end")!({ type: "agent_end", messages: [{ role: "toolResult", content: large }, assistant], context: large });
  let shutdowns = 0;
  callbacks.get("agent_settled")!({ type: "agent_settled", context: large }, { shutdown() { shutdowns++; } });
  assert.equal(shutdowns, 1);
  assert.ok(statSync(events).size < 1024, "even terminal/source boundaries never serialize cumulative context");
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    { type: "turn_end", message: assistant }, { type: "agent_end", messages: [assistant] }, { type: "agent_settled" },
  ]);
});
