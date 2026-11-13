import {
  measurementKeys,
  summarize,
  type MeasurementKey,
  type SampleSummary,
} from "./analysis.ts";
import { clockGaps } from "./chartGaps.ts";
import { sampleElapsedMs } from "./chartTime.ts";
import type { Telemetry } from "./types";
import type { ChartTimeRange } from "./chartInteraction.ts";

export const chartIndexThreshold = 2000;
export const chartPointsPerPixel = 2;
const blockSize = 32;
type Blocks = {
  first: Int32Array;
  last: Int32Array;
  min: Int32Array;
  max: Int32Array;
  count: Uint32Array;
  sum: Float64Array;
};
type ChannelIndex = { levels: Blocks[]; missing: Uint32Array };
export type ChartCoordinate = {
  times: Float64Array;
  order?: Uint32Array;
  channels: Partial<Record<MeasurementKey, ChannelIndex>>;
  gaps: Uint32Array;
};
export type ChartIndex = { clock: ChartCoordinate; elapsed: ChartCoordinate };
export type ChartPoint = [
  time: number,
  value: number | null,
  sourceIndex: number,
];
const cache = new WeakMap<Telemetry[], ChartIndex>();
export function cacheChartData(rows: Telemetry[], index: ChartIndex) {
  cache.set(rows, index);
}
export const cachedChartData = (rows: Telemetry[]) => cache.get(rows);

export function lowerBound(
  values: ArrayLike<number>,
  value: number,
  upper = false,
) {
  let low = 0,
    high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value || (upper && values[middle] === value))
      low = middle + 1;
    else high = middle;
  }
  return low;
}
function coordinate(rows: Telemetry[], elapsed: boolean): ChartCoordinate {
  const times = Float64Array.from(rows, (row) =>
    elapsed ? sampleElapsedMs(row, rows[0].timestamp) : row.timestamp,
  );
  let order: Uint32Array | undefined;
  for (let i = 1; i < times.length; i++) {
    if (times[i] >= times[i - 1]) continue;
    order = Uint32Array.from(rows, (_, index) => index).sort(
      (a, b) => times[a] - times[b] || a - b,
    );
    const original = times.slice();
    for (let j = 0; j < times.length; j++) times[j] = original[order[j]];
    break;
  }
  return {
    times,
    order,
    channels: {},
    gaps: elapsed
      ? new Uint32Array()
      : Uint32Array.from(
          clockGaps(order ? Array.from(order, (i) => rows[i]) : rows),
        ),
  };
}
function blocks(length: number): Blocks {
  return {
    first: new Int32Array(length).fill(-1),
    last: new Int32Array(length).fill(-1),
    min: new Int32Array(length).fill(-1),
    max: new Int32Array(length).fill(-1),
    count: new Uint32Array(length),
    sum: new Float64Array(length),
  };
}
function buildChannels(rows: Telemetry[], view: ChartCoordinate) {
  const source = (position: number) => view.order?.[position] ?? position;
  for (const key of measurementKeys) {
    if (!summarize(rows, key).count) continue;
    const leaves = blocks(Math.ceil(rows.length / blockSize));
    const missing: number[] = [];
    let absent = false;
    for (let i = 0; i < rows.length; i++) {
      const value = rows[source(i)][key];
      if (value == null || !Number.isFinite(value)) {
        if (!absent) missing.push(i);
        absent = true;
        continue;
      }
      absent = false;
      const node = Math.floor(i / blockSize);
      if (leaves.first[node] < 0) leaves.first[node] = i;
      leaves.last[node] = i;
      if (leaves.min[node] < 0 || value < rows[source(leaves.min[node])][key]!)
        leaves.min[node] = i;
      if (leaves.max[node] < 0 || value >= rows[source(leaves.max[node])][key]!)
        leaves.max[node] = i;
      leaves.count[node]++;
      if (key !== "energy" && key !== "capacity") leaves.sum[node] += value;
    }
    const levels = [leaves];
    while (levels.at(-1)!.first.length > 1) {
      const child = levels.at(-1)!,
        parent = blocks(Math.ceil(child.first.length / 2));
      for (let i = 0; i < child.first.length; i++) {
        if (!child.count[i]) continue;
        const node = i >>> 1;
        if (parent.first[node] < 0) parent.first[node] = child.first[i];
        parent.last[node] = child.last[i];
        const min = child.min[i],
          max = child.max[i];
        if (
          parent.min[node] < 0 ||
          rows[source(min)][key]! < rows[source(parent.min[node])][key]!
        )
          parent.min[node] = min;
        if (
          parent.max[node] < 0 ||
          rows[source(max)][key]! >= rows[source(parent.max[node])][key]!
        )
          parent.max[node] = max;
        parent.count[node] += child.count[i];
        parent.sum[node] += child.sum[i];
      }
      levels.push(parent);
    }
    view.channels[key] = { levels, missing: Uint32Array.from(missing) };
  }
}
/** Prepared once in the CSV worker; viewport queries never scan the file. */
export function indexedChartData(rows: Telemetry[]): ChartIndex | undefined {
  if (rows.length < chartIndexThreshold) return;
  const existing = cache.get(rows);
  if (existing) return existing;
  const clock = coordinate(rows, false),
    elapsed = coordinate(rows, true);
  buildChannels(rows, clock);
  if (!clock.order && !elapsed.order) elapsed.channels = clock.channels;
  else buildChannels(rows, elapsed);
  const index = { clock, elapsed };
  cache.set(rows, index);
  return index;
}
export function chartIndexBuffers(index: ChartIndex): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const view of [index.clock, index.elapsed]) {
    buffers.add(view.times.buffer as ArrayBuffer);
    if (view.order) buffers.add(view.order.buffer as ArrayBuffer);
    buffers.add(view.gaps.buffer as ArrayBuffer);
    for (const channel of Object.values(view.channels)) {
      buffers.add(channel.missing.buffer as ArrayBuffer);
      for (const level of channel.levels)
        for (const values of Object.values(level))
          buffers.add(values.buffer as ArrayBuffer);
    }
  }
  return [...buffers];
}
type Aggregate = {
  first: number;
  last: number;
  min: number;
  max: number;
  count: number;
  sum: number;
};
function aggregate(
  rows: Telemetry[],
  view: ChartCoordinate,
  key: MeasurementKey,
  start: number,
  end: number,
): Aggregate {
  const result: Aggregate = {
    first: -1,
    last: -1,
    min: -1,
    max: -1,
    count: 0,
    sum: 0,
  };
  const channel = view.channels[key];
  if (!channel) return result;
  const value = (i: number) => rows[view.order?.[i] ?? i][key]!;
  const add = (
    first: number,
    last: number,
    min: number,
    max: number,
    count: number,
    sum: number,
  ) => {
    if (!count) return;
    if (result.first < 0) result.first = first;
    result.last = last;
    if (result.min < 0 || value(min) < value(result.min)) result.min = min;
    if (result.max < 0 || value(max) >= value(result.max)) result.max = max;
    result.count += count;
    result.sum += sum;
  };
  const single = (i: number) => {
    const v = value(i);
    if (v != null && Number.isFinite(v)) add(i, i, i, i, 1, v);
  };
  while (start < end && start % blockSize) single(start++);
  let block = Math.floor(start / blockSize);
  const lastBlock = Math.floor(end / blockSize);
  while (block < lastBlock) {
    const level = Math.min(
      block ? Math.floor(Math.log2(block & -block)) : 30,
      Math.floor(Math.log2(lastBlock - block)),
      channel.levels.length - 1,
    );
    const node = block >>> level,
      values = channel.levels[level];
    add(
      values.first[node],
      values.last[node],
      values.min[node],
      values.max[node],
      values.count[node],
      values.sum[node],
    );
    block += 2 ** level;
  }
  start = Math.max(start, lastBlock * blockSize);
  while (start < end) single(start++);
  return result;
}
export function chartRangeSummary(
  rows: Telemetry[],
  key: MeasurementKey,
  range: ChartTimeRange | undefined,
  elapsed: boolean,
): SampleSummary {
  if (!range) return summarize(rows, key);
  const index = cache.get(rows);
  if (!index)
    return summarize(
      rows.filter((row) => {
        const time = elapsed
          ? sampleElapsedMs(row, rows[0]?.timestamp ?? 0)
          : row.timestamp;
        return time >= range.startValue && time <= range.endValue;
      }),
      key,
    );
  const view = elapsed ? index.elapsed : index.clock;
  const stats = aggregate(
    rows,
    view,
    key,
    lowerBound(view.times, range.startValue),
    lowerBound(view.times, range.endValue, true),
  );
  const value = (i: number) => rows[view.order?.[i] ?? i][key]!;
  return {
    count: stats.count,
    min: stats.count ? value(stats.min) : null,
    max: stats.count ? value(stats.max) : null,
    average:
      stats.count && key !== "energy" && key !== "capacity"
        ? stats.sum / stats.count
        : null,
  };
}
export function nearestChartSample(
  rows: Telemetry[],
  view: ChartCoordinate,
  time: number,
): Telemetry | undefined {
  if (
    !view.times.length ||
    !Number.isFinite(time) ||
    time < view.times[0] ||
    time > view.times.at(-1)!
  )
    return;
  let position = lowerBound(view.times, time);
  if (
    position === view.times.length ||
    (position > 0 &&
      time - view.times[position - 1] < view.times[position] - time)
  )
    position--;
  if (position > 0) {
    const gap = lowerBound(view.gaps, position);
    if (
      view.gaps[gap] === position &&
      time > view.times[position - 1] &&
      time < view.times[position]
    )
      return;
  }
  const next = lowerBound(view.gaps, position + 1);
  if (
    view.gaps[next] === position + 1 &&
    time > view.times[position] &&
    time < view.times[position + 1]
  )
    return;
  return rows[view.order?.[position] ?? position];
}
/** Two extrema per CSS pixel, with extra nulls only for real discontinuities. */
export function chartViewportData(
  rows: Telemetry[],
  view: ChartCoordinate,
  keys: MeasurementKey[],
  range: ChartTimeRange | undefined,
  pixels: number,
): Partial<Record<MeasurementKey, ChartPoint[]>> {
  const result: Partial<Record<MeasurementKey, ChartPoint[]>> = {};
  if (!view.times.length) return result;
  const start = range?.startValue ?? view.times[0],
    end = range?.endValue ?? view.times.at(-1)!;
  const first = lowerBound(view.times, start);
  const last = lowerBound(view.times, end, true);
  const buckets = Math.max(1, Math.ceil(pixels));
  const edges = [first];
  for (let x = 1; x < buckets; x++)
    edges.push(
      Math.max(
        first,
        Math.min(
          last,
          lowerBound(view.times, start + ((end - start) * x) / buckets),
        ),
      ),
    );
  edges.push(last);
  for (const key of keys) {
    const points: ChartPoint[] = [];
    const missing = view.channels[key]?.missing ?? new Uint32Array();
    let previous = -1;
    const append = (position: number) => {
      if (position < 0 || position === previous) return;
      const source = view.order?.[position] ?? position,
        value = rows[source][key];
      if (previous >= 0) {
        const gap = view.gaps[lowerBound(view.gaps, previous + 1)],
          absent = missing[lowerBound(missing, previous + 1)];
        const interruption = Math.min(gap ?? Infinity, absent ?? Infinity);
        if (interruption <= position)
          points.push([
            interruption === gap
              ? (view.times[gap - 1] + view.times[gap]) / 2
              : view.times[interruption],
            null,
            -1,
          ]);
      }
      points.push([view.times[position], value ?? null, source]);
      previous = position;
    };
    if (first > 0) append(first - 1);
    if (last - first <= buckets * chartPointsPerPixel) {
      for (let i = first; i < last; i++) append(i);
    } else {
      const whole = aggregate(rows, view, key, first, last);
      append(whole.first);
      for (let x = 0; x < buckets; x++) {
        const bin = aggregate(rows, view, key, edges[x], edges[x + 1]);
        if (bin.min < 0) continue;
        append(Math.min(bin.min, bin.max));
        append(Math.max(bin.min, bin.max));
      }
      append(whole.last);
    }
    if (last < rows.length) append(last);
    result[key] = points;
  }
  return result;
}
