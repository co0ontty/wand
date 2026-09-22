import assert from "node:assert/strict";
import test from "node:test";

import { truncateMessagesForTransport } from "../src/message-truncator.js";
import { canonicalizeStructuredImagePart, contentHasStructuredImage, normalizeStructuredToolResultContent } from "../src/structured-content.js";
import { enrichStructuredMessages } from "../src/structured-client-protocol.js";
import type { ConversationTurn, ToolResultBlock } from "../src/types.js";

const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } };

function imageTurn(toolName = "Read"): ConversationTurn {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: "t1", name: toolName, input: { file_path: "/tmp/shot.png" } },
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Read image file" }, IMAGE] },
    ],
  };
}

test("transport truncation never JSON-mangles a tool result that carries an image", () => {
  const [turn] = truncateMessagesForTransport([imageTurn()], {});
  const result = turn.content[1] as ToolResultBlock;
  assert.ok(Array.isArray(result.content), "image-bearing result must stay a content-part array");
  assert.equal(result._truncated, undefined);
  assert.deepEqual(result.content[1], IMAGE);
});

test("plain long tool results still collapse for collapsed card types", () => {
  const turn: ConversationTurn = {
    role: "assistant",
    content: [
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/tmp/a.txt" } },
      { type: "tool_result", tool_use_id: "t2", content: "x".repeat(5000) },
    ],
  };
  const [out] = truncateMessagesForTransport([turn], {});
  const result = out.content[1] as ToolResultBlock;
  assert.equal(result._truncated, true);
  assert.equal(typeof result.content, "string");
});

test("structured content normalization canonicalizes provider image shapes", () => {
  assert.deepEqual(canonicalizeStructuredImagePart({ type: "image", data: "zzz", mimeType: "image/jpeg" }), {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "zzz" },
  });
  assert.deepEqual(canonicalizeStructuredImagePart({ type: "image_url", image_url: { url: "https://x/y.png" } }), {
    type: "image",
    source: { type: "url", url: "https://x/y.png" },
  });
  const normalized = normalizeStructuredToolResultContent([
    { type: "text", text: "hi" },
    { type: "image", data: "zzz", mime_type: "image/webp" },
  ]);
  assert.ok(Array.isArray(normalized));
  assert.deepEqual(normalized[1], { type: "image", source: { type: "base64", media_type: "image/webp", data: "zzz" } });
  assert.equal(contentHasStructuredImage(normalized), true);
  assert.equal(contentHasStructuredImage("[{\"type\":\"image\"}]"), false);
});

test("outbound enrichment rewrites inline base64 images to a session image route", () => {
  const enriched = enrichStructuredMessages([imageTurn()], "sess-1");
  const result = enriched[0].content[1] as ToolResultBlock;
  assert.ok(Array.isArray(result.content));
  assert.deepEqual(result.content[1], {
    type: "image",
    source: {
      type: "url",
      url: "/api/sessions/sess-1/tool-images/t1/0",
      media_type: "image/png",
    },
  });
  // 幂等：再跑一次不会把 URL 又改回去，也不会重复改写。
  const again = enrichStructuredMessages(enriched, "sess-1");
  assert.deepEqual((again[0].content[1] as ToolResultBlock).content, result.content);
});

test("outbound enrichment without a session id keeps provider-native blocks", () => {
  const enriched = enrichStructuredMessages([imageTurn()]);
  const result = enriched[0].content[1] as ToolResultBlock;
  assert.ok(Array.isArray(result.content));
  assert.deepEqual(result.content[1], IMAGE);
});
