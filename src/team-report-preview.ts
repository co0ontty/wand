import type { TeamReportFile } from "./types.js";

const TITLE_LIMIT = 100;
const EXCERPT_LIMIT = 240;
const EXCERPT_LINES = 3;

function bounded(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
}

/** 只取真实文本，不渲染 Markdown/HTML、不读链接、不调用模型。 */
function plainText(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SUMMARY_HEADING = /^(?:\d+[.、\s]*)?(?:结论|摘要|总结|概述|验证结果|summary|conclusions?)(?:[：:].*)?$/i;

/** 完成时冻结有界预览；后续群聊列表不为预览再次读取整份文件。 */
export function teamReportPreview(text: string, fallbackTitle: string): NonNullable<TeamReportFile["preview"]> {
  const source = text.slice(0, 64 * 1024)
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const lines = source.split(/\r?\n/);
  const entries: Array<{ text: string; heading: number }> = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    const marker = /^(?:`{3,}|~{3,})/.exec(raw)?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && raw === marker) fence = null;
      continue;
    }
    if (fence || !raw || /^(?:[-*_]\s*){3,}$/.test(raw)) continue;
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(raw);
    const setext = /^(=+|-+)\s*$/.exec(lines[i + 1]?.trim() ?? "");
    const value = plainText(heading ? heading[2]! : raw);
    if (!value) continue;
    entries.push({ text: value, heading: heading ? heading[1]!.length : setext ? (setext[1]![0] === "=" ? 1 : 2) : 0 });
    if (setext) i++;
  }
  const titleEntry = entries.find((entry) => entry.heading === 1)
    ?? entries.find((entry) => entry.heading > 0 && !SUMMARY_HEADING.test(entry.text));
  const title = bounded(titleEntry?.text || plainText(fallbackTitle) || "成员报告", TITLE_LIMIT);
  const summaryAt = entries.findIndex((entry) => entry.heading > 0 && SUMMARY_HEADING.test(entry.text));
  let candidates = entries.filter((entry) => entry.heading === 0);
  if (summaryAt >= 0) {
    const section = entries.slice(summaryAt + 1);
    const nextHeading = section.findIndex((entry) => entry.heading > 0);
    const summary = section.slice(0, nextHeading < 0 ? section.length : nextHeading);
    if (summary.length) candidates = summary;
  }
  let excerpt = candidates.slice(0, EXCERPT_LINES).map((entry) => entry.text).join("\n");
  if (candidates.length > EXCERPT_LINES) excerpt += "…";
  return { title, excerpt: bounded(excerpt, EXCERPT_LIMIT) };
}
