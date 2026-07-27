import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyHost,
  type LegacyHostSlot,
} from "../src/web-ui/react/shell/index.js";

class FakeSlot implements LegacyHostSlot {
  readonly childNodes: unknown[] = [];
}

test("LegacyHost requires an empty React slot, mounts idempotently, and rejects slot switching", () => {
  const calls: string[] = [];
  const host = new LegacyHost<FakeSlot>("TestHost", {
    mount(slot) {
      calls.push("mount");
      slot.childNodes.push({ owner: "legacy" });
    },
    unmount() {
      calls.push("unmount");
    },
  });
  const slot = new FakeSlot();
  const otherSlot = new FakeSlot();

  const first = host.mount(slot);
  const second = host.mount(slot);
  assert.equal(first.generation, second.generation);
  assert.deepEqual(calls, ["mount"]);
  assert.throws(() => host.mount(otherSlot), /cannot switch to a different slot/);

  host.unmount(slot);
  host.unmount(slot);
  assert.deepEqual(calls, ["mount", "unmount"]);
  const remounted = host.mount(slot);
  assert.ok(remounted.generation > first.generation);
  assert.deepEqual(calls, ["mount", "unmount", "mount"]);
  assert.equal(host.isCurrent(first), false);
  assert.equal(host.isCurrent(remounted), true);

  host.dispose();
  assert.throws(() => host.mount(slot), /has been disposed/);

  const occupied = new FakeSlot();
  occupied.childNodes.push({ owner: "react" });
  const occupiedHost = new LegacyHost("OccupiedHost", { mount() {} });
  assert.throws(() => occupiedHost.mount(occupied), /requires an empty React slot/);
});
