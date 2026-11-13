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
  const intervals = rows
    .slice(1)
    .map((row, i) => row.timestamp - rows[i].timestamp)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const cadence = intervals[Math.floor((intervals.length - 1) / 2)];
  const result: { time: number; row?: Telemetry }[] = [];
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (!elapsed && previous) {
      const wallDelta = row.timestamp - previous.timestamp;
      const elapsedDelta =
        row.elapsedMs !== undefined && previous.elapsedMs !== undefined
          ? row.elapsedMs - previous.elapsedMs
          : undefined;
      const newSegment =
        row.segmentId !== undefined &&
        previous.segmentId !== undefined &&
        row.segmentId !== previous.segmentId;
      const paused =
        elapsedDelta !== undefined && wallDelta - elapsedDelta > 50;
      const missing =
        (row.segmentId === undefined || previous.segmentId === undefined) &&
        cadence !== undefined &&
        wallDelta > cadence * 1.5;
      if (wallDelta > 0 && (newSegment || paused || missing))
        result.push({ time: previous.timestamp + wallDelta / 2 });
    }
    result.push({
      time: elapsed ? sampleElapsedMs(row, origin) : row.timestamp,
      row,
    });
  });
  return result;
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
