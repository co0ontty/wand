import assert from "node:assert/strict";
import test from "node:test";

import {
  overlayStore,
  wandOverlay,
} from "../src/web-ui/react/overlay-controller.js";

test("closeTopmost dismisses one active dismissable dialog", async () => {
  const result = wandOverlay.dialog({
    title: "确认",
    actions: [{ label: "继续", value: "continue" }],
  });

  assert.equal(wandOverlay.closeTopmost(), true);
  assert.deepEqual(await result, { dismissed: true });
  assert.equal(overlayStore.getSnapshot().activeDialog, null);
  assert.equal(wandOverlay.closeTopmost(), false);
});

test("closeTopmost preserves a non-dismissable dialog", async () => {
  const result = wandOverlay.dialog({
    title: "正在重启",
    dismissable: false,
    actions: [],
  });
  const active = overlayStore.getSnapshot().activeDialog;

  assert.ok(active);
  assert.equal(wandOverlay.closeTopmost(), false);
  assert.strictEqual(overlayStore.getSnapshot().activeDialog, active);

  overlayStore.completeDialog(active.id, { dismissed: true });
  assert.deepEqual(await result, { dismissed: true });
});
