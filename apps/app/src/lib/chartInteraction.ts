import type { Telemetry } from "./types";
import { sampleElapsedMs } from "./chartTime.ts";

export type ChartTimeRange = { startValue: number; endValue: number };

export function samplesInChartRange(
  samples: Telemetry[],
  range: ChartTimeRange | undefined,
  elapsed: boolean,
  origin: number,
): Telemetry[] {
  if (!range) return samples;
  return samples.filter((row) => {
    const time = elapsed ? sampleElapsedMs(row, origin) : row.timestamp;
    return time >= range.startValue && time <= range.endValue;
  });
}

// Nulls break the line and its fill, and belong only to the rendered chart.
// They must never enter statistics, integration, exports or source records.
export function chartTimeline(
  rows: Telemetry[],
  elapsed: boolean,
  origin: number,
): { time: number; row?: Telemetry }[] {
  const gaps = elapsed ? [] : clockGaps(rows);
  let gap = 0;
  const result: { time: number; row?: Telemetry }[] = [];
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (gaps[gap] === index) {
      result.push({
        time: previous.timestamp + (row.timestamp - previous.timestamp) / 2,
      });
      gap++;
    }
    result.push({
      time: elapsed ? sampleElapsedMs(row, origin) : row.timestamp,
      row,
    });
  });
  return result;
}

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
  // Uniform device exports need no O(n log n) median sort.
  const cadence = uniform
    ? intervals[0]
    : intervals.sort((a, b) => a - b)[Math.floor((intervals.length - 1) / 2)];
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i],
      previous = rows[i - 1];
    const delta = row.timestamp - previous.timestamp;
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

export function zoomAxisRange(
  range: ChartTimeRange,
  anchor: number,
  delta: number,
  minimumSpan: number,
  domain?: ChartTimeRange,
): ChartTimeRange {
  const span = range.endValue - range.startValue;
  const ratio = Math.max(0, Math.min(1, anchor));
  const maximumSpan = domain ? domain.endValue - domain.startValue : 1e15;
  const nextSpan = Math.max(
    Math.min(minimumSpan, maximumSpan),
    Math.min(maximumSpan, span * Math.exp(Math.sign(delta) * 0.2)),
  );
  let startValue = range.startValue + (span - nextSpan) * ratio;
  if (domain)
    startValue = Math.max(
      domain.startValue,
      Math.min(domain.endValue - nextSpan, startValue),
    );
  return { startValue, endValue: startValue + nextSpan };
}
