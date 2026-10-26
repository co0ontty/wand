import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Plugin } from "esbuild";

/** Retained group-chat flows run explicitly enabled; the shipped default has its own regression. */
export const retainedGroupChatFixture: Plugin = {
  name: "retained-group-chat-fixture",
  setup(build) {
    build.onLoad({ filter: /[/\\]group-chat-visibility\.ts$/ }, ({ path }) => {
      const source = readFileSync(path, "utf8");
      const enabled = source.replace(/GROUP_CHAT_VISIBLE\s*=\s*false/, "GROUP_CHAT_VISIBLE = true");
      assert.notEqual(enabled, source, "the fixture must explicitly override the production visibility switch");
      return { contents: enabled, loader: "ts" };
    });
  },
};
