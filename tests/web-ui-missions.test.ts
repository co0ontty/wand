import assert from "node:assert/strict";
import test from "node:test";

import {
  configureMissionsRuntime,
  missionsController,
  missionsStore,
} from "../src/web-ui/react/missions/controller.js";

test("mission dispatch blocks overlay switching until the operation finishes", () => {
  let closed = 0;
  const restore = configureMissionsRuntime({
    onOpen() {},
    onClose() { closed += 1; },
    async openSession() {},
    effectiveCwd: () => "/tmp",
  });
  try {
    missionsController.open();
    const revision = missionsStore.getSnapshot().revision;
    missionsController.setDismissable(false);

    assert.equal(missionsController.closeIfOpen(), false);
    assert.equal(missionsController.isOpen(), true);
    assert.equal(closed, 0);
    assert.equal(missionsStore.getSnapshot().revision, revision,
      "locking the form must not restart the host's loading lifecycle");

    missionsController.setDismissable(true);
    assert.equal(missionsController.closeIfOpen(), true);
    assert.equal(missionsController.isOpen(), false);
    assert.equal(closed, 1);
  } finally {
    missionsController.close();
    restore();
  }
});

test("a later mission dialog does not inherit a previous operation's close lock", () => {
  try {
    missionsController.open();
    missionsController.setDismissable(false);
    missionsController.close();
    missionsController.open();

    assert.equal(missionsStore.getSnapshot().dismissable, true);
    assert.equal(missionsController.closeIfOpen(), true);
  } finally {
    missionsController.close();
  }
});
