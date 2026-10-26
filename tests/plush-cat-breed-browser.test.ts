import test from "node:test";
import { runNodeHarness } from "./helpers/test-process.js";

test("Garfield and silver shaded render with unclipped breed-specific 3D and static fallbacks", {
  skip: process.env.WAND_CAT_BREED_QA !== "1", timeout: 120_000,
}, async (t) => {
  await runNodeHarness(t, "tests/helpers/cat-breed-browser.mjs", {
    timeoutMs: 115_000,
  });
});
