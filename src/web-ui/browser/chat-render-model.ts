// Small synchronous helpers shared by event routing and the optional renderer.
import { escapeHtml } from "./utils";

export function formatInlineResult(content, toolName) {
  if (!content) return '<span class="inline-tool-empty">无输出</span>';
  return '<pre class="inline-tool-result-text" style="max-height: 300px; overflow-y: auto;">' + escapeHtml(content) + '</pre>';
}

export function shortCommand(cmd) {
  var value = String(cmd || "").trim();
  return value.length <= 24 ? value || "未选择会话" : value.slice(0, 21) + "...";
}

export function setInlineToolImageState(image: Element, state: "ready" | "error"): void {
  image.closest(".inline-tool-image")?.setAttribute("data-image-state", state);
}
