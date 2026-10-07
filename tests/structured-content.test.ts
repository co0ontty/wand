import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeToolResultContent,
  contentHasStructuredImage,
  toolResultContentToAgentParts,
} from "../src/structured-content.js";
import { toolResultPreview } from "../src/tool-preview.js";

test("canonicalizeToolResultContent collapses pure-text results into strings", () => {
  assert.equal(canonicalizeToolResultContent("simple text"), "simple text");
  assert.equal(
    canonicalizeToolResultContent({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    }),
    "line 1\nline 2",
  );
  assert.equal(canonicalizeToolResultContent({ output: "command output" }), "command output");
});

test("canonicalizeToolResultContent preserves and canonicalizes multimodal image parts", () => {
  const result = canonicalizeToolResultContent({
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "base64data123", mimeType: "image/png" },
    ],
  });

  assert.ok(Array.isArray(result), "multimodal result must remain an array");
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { type: "text", text: "Read image file [image/png]" });
  assert.deepEqual(result[1], {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "base64data123",
    },
  });
  assert.ok(contentHasStructuredImage(result));
});

test("toolResultContentToAgentParts formats parts for upstream Agent/LLM with image support", () => {
  const agentParts = toolResultContentToAgentParts([
    { type: "text", text: "Here is the screenshot" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "jpegdata456",
      },
    },
  ]);

  assert.deepEqual(agentParts, [
    { type: "text", text: "Here is the screenshot" },
    { type: "image", data: "jpegdata456", mimeType: "image/jpeg" },
  ]);

  assert.deepEqual(toolResultContentToAgentParts("just text"), [
    { type: "text", text: "just text" },
  ]);
});

test("toolResultPreview describes pure image results cleanly", () => {
  const preview = toolResultPreview({
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "img",
        },
      },
    ],
  });
  assert.equal(preview, "返回 1 张图片");
});
