import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { importPiCliModule, resolvePiCliPackage } from "../src/pi-cli-runtime.js";

// Exercise the actual installed CLI's extension facade, without creating an SDK
// session, a ModelRuntime, a process, or a provider request.
test("installed Pi extension sendUserMessage cannot acknowledge an async steering enqueue", async (t) => {
  let root: string;
  try { root = resolvePiCliPackage(); }
  catch { t.skip("Pi CLI installation unavailable"); return; }
  const loader = await importPiCliModule<{
    createExtensionRuntime(): { sendUserMessage: (content: string, options: unknown) => unknown };
    loadExtensionFromFactory(factory: (pi: ExtensionAPI) => void, cwd: string,
      bus: unknown, runtime: unknown, name: string): Promise<unknown>;
  }>(root, "core/extensions/loader.js");
  const runtime = loader.createExtensionRuntime();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let queued = false;
  let calls = 0;
  runtime.sendUserMessage = async (content, options) => {
    calls++;
    assert.equal(content, "next durable input");
    assert.deepEqual(options, { deliverAs: "steer", expandPromptTemplates: false });
    await gate;
    queued = true;
  };
  let boundary!: () => Promise<void>;
  let returned: unknown = "not called";
  await loader.loadExtensionFromFactory((pi) => {
    boundary = async () => {
      returned = pi.sendUserMessage("next durable input", { deliverAs: "steer", expandPromptTemplates: false });
      await returned;
    };
  }, process.cwd(), {}, runtime, "wand-native-steering-contract-probe");
  await boundary();
  assert.equal(calls, 1);
  assert.equal(returned, undefined, "the public facade discards the runtime promise");
  assert.equal(queued, false, "awaiting the extension API does not wait for native steering acceptance");
  release();
  await gate;
  assert.equal(queued, true);
});
