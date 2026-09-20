import { clampFilePreviewFontSize, defaultFilePreviewFontSize } from "../file-preview/model";

export {
  clampFilePreviewFontSize as clampCodeEditorFontSize,
  defaultFilePreviewFontSize as defaultCodeEditorFontSize,
};

/** One occurrence of the find query inside the draft. */
export interface CodeEditorFindMatch {
  /** Inclusive character offset of the first character. */
  start: number;
  /** Exclusive character offset of the last character. */
  end: number;
  /** 1-based line number of `start`, for the "第 N 行" hint and for scrolling. */
  line: number;
}

export interface CodeEditorFindOptions {
  /** Defaults to false: code search is usually case-insensitive first. */
  caseSensitive?: boolean;
}

/**
 * Beyond this many occurrences the overlay stops painting per-match highlights.
 * Splitting the syntax layer thousands of times turns a one-character query
 * into a DOM blowout; the count and navigation keep working regardless.
 */
export const maxCodeEditorFindHighlights = 500;

/**
 * Non-overlapping occurrences of `query` in `text`, in document order.
 *
 * Folding case must not shift offsets, otherwise every highlight after the
 * first length-changing character would land one column off — the same guard
 * the explorer search uses for file names.
 */
export function codeEditorFindMatches(
  text: string,
  query: string,
  options: CodeEditorFindOptions = {},
): CodeEditorFindMatch[] {
  if (!query) return [];
  const caseSensitive = options.caseSensitive === true;
  const haystack = caseSensitive ? text : text.toLowerCase();
  // `toLowerCase()` can change length for some code points, and then byte
  // offsets from the folded string no longer address the original text.
  if (haystack.length !== text.length) return caseSensitiveMatches(text, query);
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: CodeEditorFindMatch[] = [];
  let line = 1;
  let scannedTo = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    line += countNewlines(text, scannedTo, index);
    scannedTo = index;
    matches.push({ start: index, end: index + needle.length, line });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return matches;
}

/** Same scan with an exact needle, used when case folding would move offsets. */
function caseSensitiveMatches(text: string, query: string): CodeEditorFindMatch[] {
  const matches: CodeEditorFindMatch[] = [];
  let line = 1;
  let scannedTo = 0;
  let index = text.indexOf(query);
  while (index !== -1) {
    line += countNewlines(text, scannedTo, index);
    scannedTo = index;
    matches.push({ start: index, end: index + query.length, line });
    index = text.indexOf(query, index + query.length);
  }
  return matches;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** Wrap-around step through `count` matches. */
export function stepCodeEditorFindIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  const normalized = ((current % count) + count) % count;
  return (((normalized + delta) % count) + count) % count;
}
