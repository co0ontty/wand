import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 只识别明确交付的报告链接，不能把普通代码/历史文档或外部 URL 当成新报告。 */
export function linkedTeamReportFile(
  cwd: string, reply: string, startedAt: string | null,
): { path: string; relativePath: string; mtimeMs: number } | null {
  const started = Date.parse(startedAt ?? "");
  if (!Number.isFinite(started)) return null;
  const candidates = new Map<string, { path: string; relativePath: string; mtimeMs: number }>();
  try {
    const root = realpathSync(cwd);
    const links = /\[([^\]\r\n]+)\]\(\s*(?:<([^>\r\n]+)>|([^\s)]+))\s*\)/g;
    const references = [
      ...[...reply.matchAll(links)].map((m) => ({ raw: m[2] ?? m[3]!, label: m[1]!, index: m.index, text: m[0] })),
      ...[...reply.matchAll(/`([^`\r\n]+\.(?:md|markdown))`/gi)]
        .map((m) => ({ raw: m[1]!, label: "", index: m.index, text: m[0] })),
    ];
    for (const reference of references) {
      const { raw } = reference;
      const before = reply.slice(reply.lastIndexOf("\n", reference.index) + 1, reference.index);
      const delivered = /(?:已(?:写入|保存|生成|完成)|交付|报告(?:文件)?[：:]|report\s*[:：]|\b(?:written|saved|created|delivered)\b)/i.test(before)
        || reply.trim() === reference.text;
      if (!delivered || !/(?:报告|report)/i.test(`${reference.label} ${before} ${path.basename(raw)}`)) continue;
      if (!/\.(?:md|markdown)$/i.test(raw)) continue;
      try {
        const local = /^file:/i.test(raw) ? fileURLToPath(raw)
          : /^[a-z][a-z\d+.-]*:/i.test(raw) && !path.isAbsolute(raw) ? null
            : decodeURIComponent(raw);
        if (!local) continue;
        const file = realpathSync(path.resolve(root, local));
        const relativePath = path.relative(root, file);
        if (!/\.(?:md|markdown)$/i.test(file)) continue;
        if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue;
        const stat = statSync(file);
        // 文件系统有亚毫秒精度，startedAt 只有整数毫秒；同一毫秒不能误判为旧文件。
        if (!stat.isFile() || Math.ceil(stat.mtimeMs) < started) continue;
        candidates.set(file, { path: file, relativePath, mtimeMs: stat.mtimeMs });
      } catch {
        // 无法读取/无效路径不构成文件交付，保留原有回复兜底。
      }
    }
  } catch {
    return null;
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}
