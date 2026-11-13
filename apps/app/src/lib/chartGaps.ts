import type { Telemetry } from "./types";

const gapsCache = new WeakMap<Telemetry[], number[]>();
export function clockGaps(rows: Telemetry[]): number[] {
  const cached = gapsCache.get(rows);
  if (cached) return cached;
  const intervals: number[] = [];
  let uniform = true;
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].timestamp - rows[i - 1].timestamp;
    if (delta > 0) {
      if (intervals.length && delta !== intervals[0]) uniform = false;
      intervals.push(delta);
    }
  }
  const cadence = uniform
    ? intervals[0]
    : intervals.sort((a, b) => a - b)[Math.floor((intervals.length - 1) / 2)];
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i],
      previous = rows[i - 1],
      delta = row.timestamp - previous.timestamp;
    const paused =
      row.elapsedMs !== undefined &&
      previous.elapsedMs !== undefined &&
      delta - (row.elapsedMs - previous.elapsedMs) > 50;
    const segment =
      row.segmentId !== undefined &&
      previous.segmentId !== undefined &&
      row.segmentId !== previous.segmentId;
    const missing =
      (row.segmentId === undefined || previous.segmentId === undefined) &&
      cadence !== undefined &&
      delta > cadence * 1.5;
    if (delta > 0 && (paused || segment || missing)) gaps.push(i);
  }
  gapsCache.set(rows, gaps);
  return gaps;
}
