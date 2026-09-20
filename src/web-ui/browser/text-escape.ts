// HTML 文本转义。
// 单独一个模块（而不是留在 utils.ts）是为了让纯字符串渲染 helper（如
// todo-progress.ts）能在 Node 单测里直接 import：utils.ts 顶部会连带拉进
// DOM 代码（render.ts 顶层就用了 window），一 import 就 ReferenceError。
// utils.ts 继续 re-export 这个名字，历史调用点不用改。
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
