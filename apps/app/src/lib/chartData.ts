import { measurementKeys } from "./analysis.ts";
import { clockGaps } from "./chartInteraction.ts";
import { sampleElapsedMs } from "./chartTime.ts";
import type { Telemetry } from "./types";

export const packedChartThreshold = 20_000;
export const chartDimensions = ["clock", "elapsed", ...measurementKeys];
export type PackedChartData = {
  clock: Float64Array;
  elapsed: Float64Array;
  origin: number;
};
const cache = new WeakMap<Telemetry[], PackedChartData>();

export function cacheChartData(rows: Telemetry[], data: PackedChartData) {
  cache.set(rows, data);
}

/** ECharts shares this full-resolution store across all selected series. */
export function packedChartData(
  rows: Telemetry[],
): PackedChartData | undefined {
  if (rows.length < packedChartThreshold) return;
  const existing = cache.get(rows);
  if (existing) return existing;
  const gaps = clockGaps(rows);
  const width = chartDimensions.length;
  const clock = new Float64Array((rows.length + gaps.length) * width);
  const elapsed = gaps.length ? new Float64Array(rows.length * width) : clock;
  const origin = rows[0].timestamp;
  let gap = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (gaps[gap] === i) {
      const offset = (i + gap) * width;
      clock.fill(NaN, offset, offset + width);
      clock[offset] =
        rows[i - 1].timestamp + (row.timestamp - rows[i - 1].timestamp) / 2;
      gap++;
    }
    const offset = (i + gap) * width;
    clock[offset] = row.timestamp;
    clock[offset + 1] = sampleElapsedMs(row, origin);
    for (let field = 0; field < measurementKeys.length; field++)
      clock[offset + field + 2] = row[measurementKeys[field]] ?? NaN;
    if (elapsed !== clock)
      elapsed.set(clock.subarray(offset, offset + width), i * width);
  }
  const data = { clock, elapsed, origin };
  cache.set(rows, data);
  return data;
}
