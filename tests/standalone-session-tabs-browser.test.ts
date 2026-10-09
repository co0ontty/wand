import { test } from "node:test";
import { runStandaloneSessionTabsBrowser } from "./helpers/standalone-session-tabs-browser.mjs";

test("standalone session tabs use directory ownership, native selection and existing browser owners", {
  skip: process.env.WAND_STANDALONE_TABS_BROWSER !== "1", timeout: 180_000,
}, async () => {
  await runStandaloneSessionTabsBrowser();
});
