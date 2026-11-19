import type { Telemetry } from "./types";
import { sampleElapsedMs } from "./chartTime.ts";
import { cachedChartData, lowerBound } from "./chartData.ts";
import { clockGaps } from "./chartGaps.ts";
export { clockGaps } from "./chartGaps.ts";

export type ChartTimeRange = { startValue: number; endValue: number };
export const minimumChartTimeSpan = 1000;

export function clampChartTimeRange(
  range: ChartTimeRange,
  domain: ChartTimeRange,
): ChartTimeRange {
  const span = Math.min(
    domain.endValue - domain.startValue,
    Math.max(minimumChartTimeSpan, range.endValue - range.startValue),
  );
  const center = (range.startValue + range.endValue) / 2;
  const startValue = Math.max(
    domain.startValue,
    Math.min(domain.endValue - span, center - span / 2),
  );
  return { startValue, endValue: startValue + span };
}
const rangeCache = new WeakMap<
  Telemetry[],
  {
    start: number;
    end: number;
    elapsed: boolean;
    origin: number;
    rows: Telemetry[];
  }
>();

export function samplesInChartRange(
  samples: Telemetry[],
  range: ChartTimeRange | undefined,
  elapsed: boolean,
  origin: number,
): Telemetry[] {
  if (!range) return samples;
  const cached = rangeCache.get(samples);
  if (
    cached &&
    cached.start === range.startValue &&
    cached.end === range.endValue &&
    cached.elapsed === elapsed &&
    cached.origin === origin
  )
    return cached.rows;
  const index = cachedChartData(samples);
  const view = elapsed
    ? origin === samples[0]?.timestamp
      ? index?.elapsed
      : undefined
    : index?.clock;
  const rows =
    view && !view.order
      ? (() => {
          const first = lowerBound(view.times, range.startValue),
            last = lowerBound(view.times, range.endValue, true);
          return first === 0 && last === samples.length
            ? samples
            : samples.slice(first, last);
        })()
      : samples.filter((row) => {
          const time = elapsed ? sampleElapsedMs(row, origin) : row.timestamp;
          return time >= range.startValue && time <= range.endValue;
        });
  rangeCache.set(samples, {
    start: range.startValue,
    end: range.endValue,
    elapsed,
    origin,
    rows,
  });
  return rows;
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

/** A null separator makes the whole interval between recorded segments empty. */
export function nearestTimelineSample(
  timeline: { time: number; row?: Telemetry }[],
  time: number,
): Telemetry | undefined {
  if (!Number.isFinite(time)) return;
  let position = 0,
    high = timeline.length;
  while (position < high) {
    const middle = (position + high) >>> 1;
    if (timeline[middle].time < time) position = middle + 1;
    else high = middle;
  }
  const right = timeline[position];
  if (right?.time === time) return right.row;
  const left = timeline[position - 1];
  if (!left?.row || !right?.row) return;
  return time - left.time < right.time - time ? left.row : right.row;
}

export function zoomAxisRange(
  range: ChartTimeRange,
  anchor: number,
  delta: number,
  minimumSpan: number,
  domain?: ChartTimeRange,
): ChartTimeRange {
  return scaleAxisRange(
    range,
    anchor,
    Math.exp(Math.sign(delta) * 0.2),
    minimumSpan,
    domain,
  );
}

/** Pinch uses distance from gesture start, so event frequency cannot multiply zoom. */
export function pinchAxisRange(
  range: ChartTimeRange,
  anchor: number,
  initialDistance: number,
  distance: number,
  domain: ChartTimeRange,
): ChartTimeRange {
  const factor = Math.sqrt(
    Math.max(1, initialDistance) / Math.max(1, distance),
  );
  return scaleAxisRange(range, anchor, factor, minimumChartTimeSpan, domain);
}

function scaleAxisRange(
  range: ChartTimeRange,
  anchor: number,
  factor: number,
  minimumSpan: number,
  domain?: ChartTimeRange,
): ChartTimeRange {
  const span = range.endValue - range.startValue;
  const ratio = Math.max(0, Math.min(1, anchor));
  const maximumSpan = domain ? domain.endValue - domain.startValue : 1e15;
  const nextSpan = Math.max(
    Math.min(minimumSpan, maximumSpan),
    Math.min(maximumSpan, span * factor),
  );
  let startValue = range.startValue + (span - nextSpan) * ratio;
  if (domain)
    startValue = Math.max(
      domain.startValue,
      Math.min(domain.endValue - nextSpan, startValue),
    );
  return { startValue, endValue: startValue + nextSpan };
}
