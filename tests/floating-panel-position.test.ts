import assert from "node:assert/strict";
import test from "node:test";

import { computeFloatingPanelPosition } from "../src/web-ui/browser/floating-panel-position.js";

const bounds = { left: 0, top: 0, right: 360, bottom: 640 };

test("floating panel stays above the anchor when enough room is available", () => {
  assert.deepEqual(
    computeFloatingPanelPosition(
      { left: 290, top: 500, right: 344, bottom: 554 },
      bounds,
      224,
      210,
    ),
    { left: 120, top: 280, placement: "above" },
  );
});

test("floating panel flips below a top-edge anchor and clamps horizontally", () => {
  assert.deepEqual(
    computeFloatingPanelPosition(
      { left: 0, top: 8, right: 54, bottom: 62 },
      bounds,
      224,
      210,
    ),
    { left: 8, top: 72, placement: "below" },
  );
});

test("floating panel is clamped to the visible bottom edge when neither side fits", () => {
  assert.deepEqual(
    computeFloatingPanelPosition(
      { left: 200, top: 290, right: 254, bottom: 344 },
      { left: 0, top: 100, right: 360, bottom: 500 },
      224,
      380,
    ),
    { left: 30, top: 108, placement: "above" },
  );
});
