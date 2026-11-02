import { diffChars, diffLines } from "diff";

export interface DiffLine { number: number; text: string; }
export interface DiffRow { left?: DiffLine; right?: DiffLine; changed: boolean; hunk: number; index: number; }
export interface DiffModel { rows: DiffRow[]; added: number; removed: number; hunks: number; }
export type VisibleDiffRow = { type: "line"; row: DiffRow } | { type: "fold"; from: number; to: number; count: number };
const lines = (text: string): string[] => text.replace(/\n$/, "").split("\n");

/** Preview projection over the installed jsdiff implementation; no handwritten diff algorithm. */
export function lineDiff(before: string, after: string): DiffModel {
  const parts = diffLines(before, after);
  const rows: DiffRow[] = [];
  let left = 1, right = 1, added = 0, removed = 0, hunks = 0;
  for (let part = 0; part < parts.length; part++) {
    const current = parts[part];
    if (!current.added && !current.removed) {
      for (const text of lines(current.value)) rows.push({ left: { number: left++, text }, right: { number: right++, text }, changed: false, hunk: 0, index: rows.length });
      continue;
    }
    const oldLines: string[] = [], newLines: string[] = [];
    while (part < parts.length && (parts[part].added || parts[part].removed)) {
      const segment = parts[part];
      (segment.removed ? oldLines : newLines).push(...lines(segment.value));
      part++;
    }
    part--;
    hunks++; added += newLines.length; removed += oldLines.length;
    for (let line = 0; line < Math.max(oldLines.length, newLines.length); line++) {
      rows.push({ left: line < oldLines.length ? { number: left++, text: oldLines[line] } : undefined,
        right: line < newLines.length ? { number: right++, text: newLines[line] } : undefined,
        changed: true, hunk: hunks, index: rows.length });
    }
  }
  return { rows, added, removed, hunks };
}

export function visibleDiff(rows: DiffRow[], expanded: Set<number>, showAll: boolean): VisibleDiffRow[] {
  if (showAll || !rows.some(row => row.changed)) return rows.map(row => ({ type: "line", row }));
  const result: VisibleDiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].changed) { result.push({ type: "line", row: rows[index++] }); continue; }
    let end = index;
    while (end < rows.length && !rows[end].changed) end++;
    const front = index === 0 ? 0 : 2, back = end === rows.length ? 0 : 2;
    const from = index + front, to = end - back;
    if (to - from < 3 || expanded.has(from)) {
      for (; index < end; index++) result.push({ type: "line", row: rows[index] });
    } else {
      for (; index < from; index++) result.push({ type: "line", row: rows[index] });
      result.push({ type: "fold", from, to, count: to - from });
      for (index = to; index < end; index++) result.push({ type: "line", row: rows[index] });
    }
  }
  return result;
}

export function inlineSegments(left: string, right: string, side: "left" | "right"): Array<{ text: string; changed: boolean }> {
  return diffChars(left, right).filter(part => side === "left" ? !part.added : !part.removed)
    .map(part => ({ text: part.value, changed: !!(part.added || part.removed) }));
}
