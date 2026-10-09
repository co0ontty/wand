import assert from "node:assert/strict";
import test from "node:test";
import { extractToolResultImages, extractToolResultText, toolResultPreview } from "../src/web-ui/browser/tool-result-display.js";

const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" };

test("MCP and Anthropic image results render as images, with text kept separately", () => {
  const content = [{ type: "text", text: "页面截图" }, image,
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } }];
  assert.deepEqual(extractToolResultImages(content), [
    { src: `data:image/png;base64,${image.data}` }, { src: "data:image/jpeg;base64,/9j/AAAA" },
  ]);
  assert.equal(extractToolResultText(content), "页面截图");
  assert.equal(toolResultPreview({ preview: JSON.stringify(image), content }), "图片结果 · 展开查看");
});

test("serialized MCP result envelopes separate images from readable output", () => {
  const result = JSON.stringify({ content: [{ type: "text", text: "已读取页面" }, image] });
  assert.deepEqual(extractToolResultImages(result), [{ src: `data:image/png;base64,${image.data}` }]);
  assert.equal(extractToolResultText(result), "已读取页面");
  assert.equal(extractToolResultText([{ type: "text", text: result }]), "已读取页面");
});

test("truncated image previews stay understandable without fetching a result", () => {
  assert.equal(toolResultPreview({ preview: '{"type":"image","data":"iVBORw0KGgoAAAA...' }), "图片结果 · 展开查看");
  assert.equal(toolResultPreview({ preview: "/9j/" + "a".repeat(60) }), "图片结果 · 展开查看");
  assert.equal(toolResultPreview({ preview: "命令失败，退出码 1" }), "命令失败，退出码 1");
});

test("ordinary JSON, unrecognized content and malformed envelopes remain diagnostic text", () => {
  const json = '{"status":"ok","count":2}';
  assert.equal(extractToolResultText(json), json);
  assert.equal(extractToolResultText('[{"type":"image",broken]'), '[{"type":"image",broken]');
  assert.equal(extractToolResultText([{ type: "resource", uri: "test.txt" }]), '{"type":"resource","uri":"test.txt"}');
  assert.deepEqual(extractToolResultImages([{ type: "image", data: "payload", mimeType: "text/html" }]), []);
});
