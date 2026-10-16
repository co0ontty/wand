/** Read-only design study geometry. Not a scheduler and not an inference of
 * actual duration from ScheduledTaskRun.executionFinishedAt (which can be a
 * reconciliation timestamp). Explicit ends here are fictional interval inputs. */
export interface StudyTime { key: string; start: number; end?: number; }
export interface StudyPosition<T extends StudyTime> { item: T; lane: number; lanes: number; top: number; height: number; }
export interface StudyCluster<T extends StudyTime> { key: string; start: number; end: number; lanes: number; positions: StudyPosition<T>[]; }
export interface StudyDisplay<T extends StudyTime> { columns: number; visible: StudyPosition<T>[]; hidden: StudyPosition<T>[]; }
export const STUDY_HOUR_PIXELS = 64;
export const STUDY_MARKER_HEIGHT = 44;
export const STUDY_MIN_COLUMN = 84;
export const STUDY_COLUMN_GAP = 4;

/** Half-open intervals [start,end): an event ending at 10:00 does not block a
 * second one starting at 10:00. Visual minimum height still prevents hitbox
 * collisions for short/point events, without pretending it is real duration. */
export function studyClusters<T extends StudyTime>(input: readonly T[], hourPixels = STUDY_HOUR_PIXELS, markerHeight = STUDY_MARKER_HEIGHT): StudyCluster<T>[] {
  if (!(hourPixels > 0) || !(markerHeight > 0) || input.length > 1000) throw new Error("Invalid bounded study geometry");
  const seen = new Set<string>();
  const items = input.map(item => {
    if (seen.has(item.key) || !Number.isFinite(item.start) || item.start < 0 || item.start >= 1440 || item.end !== undefined && (!Number.isFinite(item.end) || item.end <= item.start || item.end > 1440)) throw new Error("Invalid explicit study interval");
    seen.add(item.key);
    return { item, top: item.start * hourPixels / 60, end: Math.max((item.end ?? item.start) * hourPixels / 60, item.start * hourPixels / 60 + markerHeight) };
  }).sort((a, b) => a.item.start - b.item.start || b.end - a.end || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0));
  const groups: StudyCluster<T>[] = [];
  let cluster: typeof items = [], bottom = -1;
  const flush = () => {
    if (!cluster.length) return;
    const ends: number[] = [];
    const positions = cluster.map(item => {
      let lane = ends.findIndex(end => end <= item.top);
      if (lane < 0) lane = ends.length;
      ends[lane] = item.end;
      return { item: item.item, top: item.top, height: item.end - item.top, lane, lanes: 0 };
    });
    for (const position of positions) position.lanes = ends.length;
    groups.push({ key: cluster.map(item => item.item.key).join(":"), start: cluster[0].item.start, end: Math.max(...cluster.map(item => item.end)) * 60 / hourPixels, lanes: ends.length, positions });
  };
  for (const item of items) {
    if (cluster.length && item.top >= bottom) { flush(); cluster = []; bottom = -1; }
    cluster.push(item); bottom = Math.max(bottom, item.end);
  }
  flush(); return groups;
}

/** Width is measured, not guessed by an event-count breakpoint. Reserve the
 * final column for a truthful +N trigger when actual concurrency exceeds the
 * readable capacity. N counts hidden events, not maximum simultaneous runs. */
export function studyDisplay<T extends StudyTime>(cluster: StudyCluster<T>, dayWidth: number): StudyDisplay<T> {
  const capacity = Math.max(1, Math.min(3, Math.floor((dayWidth + STUDY_COLUMN_GAP) / (STUDY_MIN_COLUMN + STUDY_COLUMN_GAP))));
  const columns = Math.min(capacity, cluster.lanes);
  const realColumns = cluster.lanes > capacity ? columns - 1 : columns;
  return { columns, visible: cluster.positions.filter(position => position.lane < realColumns), hidden: cluster.positions.filter(position => position.lane >= realColumns) };
}
