import type { Telemetry } from "./types";

export const measurements = {
  voltage: { name: "电压", unit: "V" },
  current: { name: "电流", unit: "A" },
  power: { name: "功率", unit: "W" },
  resistance: { name: "电阻", unit: "Ω" },
  energy: { name: "电量", unit: "Wh" },
  capacity: { name: "容量", unit: "mAh" },
  cpuTemperature: { name: "CPU 温度", unit: "°C" },
  mosTemperature: { name: "MOS 温度", unit: "°C" },
  ntcTemperature: { name: "NTC 温度", unit: "°C" },
  fanSpeed: { name: "风扇转速", unit: "RPM" },
} as const;
export type MeasurementKey = keyof typeof measurements;
export const defaultCurveWidth = 1;
export const measurementKeys = Object.keys(measurements) as MeasurementKey[];
export function readChartSelection(): MeasurementKey[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem("atorch-chart-selection") ?? "null",
    );
    if (Array.isArray(saved)) {
      const selected = [...new Set(saved)].filter(
        (key): key is MeasurementKey => measurementKeys.includes(key),
      );
      if (selected.length) return selected;
    }
  } catch {
    // Keep the default curves if a saved preference cannot be read.
  }
  return ["voltage", "current"];
}

export type ChartBounds = Partial<
  Record<
    MeasurementKey,
    {
      min?: number;
      max?: number;
      color?: string;
      width?: number;
      lineOpacity?: number;
      areaOpacity?: number;
    }
  >
>;

export function chartAxisRange(
  key: MeasurementKey,
  rows: Telemetry[],
  custom?: { min?: number; max?: number },
  observed = summarize(rows, key),
): { min?: number; max?: number } {
  if (custom?.min !== undefined || custom?.max !== undefined)
    return { min: custom.min, max: custom.max };
  let low = 0;
  let high = 0;
  low = Math.min(0, observed.min ?? 0);
  high = Math.max(0, observed.max ?? 0);
  if (key === "current") {
    const magnitude = Math.max(Math.abs(low), high);
    // Keep zero exactly halfway up, including an all-zero / empty trace.
    const step = magnitude ? 10 ** Math.floor(Math.log10(magnitude)) : 1;
    const limit = magnitude
      ? Number((Math.ceil((magnitude * 1.1) / step) * step).toPrecision(12))
      : 1;
    return { min: -limit, max: limit };
  }
  // Negative temperatures / imported measurements remain visible.
  return { min: low, max: high > 0 ? undefined : low < 0 ? 0 : 1 };
}

export function groupChartAxes(
  selected: MeasurementKey[],
  rows: Telemetry[],
  bounds: ChartBounds = {},
  summary: (key: MeasurementKey) => SampleSummary = (key) =>
    summarize(rows, key),
) {
  const groups: { unit: string; keys: MeasurementKey[] }[] = [];
  for (const key of selected) {
    const unit = measurements[key].unit;
    const group = groups.find((axis) => axis.unit === unit);
    if (group) {
      if (!group.keys.includes(key)) group.keys.push(key);
    } else groups.push({ unit, keys: [key] });
  }
  const leftCount = Math.ceil(groups.length / 2);
  return groups.map((group, index) => {
    const limits = group.keys.map((key) =>
      chartAxisRange(key, rows, bounds[key], summary(key)),
    );
    let observedMin = Infinity;
    let observedMax = -Infinity;
    const lows: number[] = [];
    const highs: number[] = [];
    for (const [keyIndex, key] of group.keys.entries()) {
      const stats = summary(key);
      const low = stats.min ?? Infinity;
      const high = stats.max ?? -Infinity;
      observedMin = Math.min(observedMin, low);
      observedMax = Math.max(observedMax, high);
      lows.push(limits[keyIndex].min ?? (Number.isFinite(low) ? low : 0));
      highs.push(limits[keyIndex].max ?? (Number.isFinite(high) ? high : 1));
    }
    const range =
      group.keys.length === 1
        ? limits[0]
        : {
            min: Math.min(...lows),
            max:
              limits.every((limit) => limit.max !== undefined) ||
              group.keys.some((key) => bounds[key]?.max !== undefined)
                ? Math.max(...highs)
                : undefined,
          };
    const low = range.min ?? (Number.isFinite(observedMin) ? observedMin : 0);
    const high = range.max ?? (Number.isFinite(observedMax) ? observedMax : 1);
    return {
      ...group,
      ...range,
      position: index < leftCount ? ("left" as const) : ("right" as const),
      customMin: group.keys.some((key) => bounds[key]?.min !== undefined),
      customMax: group.keys.some((key) => bounds[key]?.max !== undefined),
      magnitude: Math.max(
        Number.isFinite(observedMin) ? Math.abs(observedMin) : 0,
        Number.isFinite(observedMax) ? Math.abs(observedMax) : 0,
      ),
      labelValues: [0, low, high],
    };
  });
}

export const chartHeightLimits = { min: 240, max: 1000 };
export function chartGridCount(height: number): 5 | 10 {
  return height >= 520 ? 10 : 5;
}

export function readChartHeight(fallback: number): number {
  try {
    for (const key of [
      "atorch-chart-height",
      "atorch-live-chart-height",
      "atorch-review-chart-height",
    ]) {
      const value = Number(localStorage.getItem(key));
      if (
        Number.isFinite(value) &&
        value >= chartHeightLimits.min &&
        value <= chartHeightLimits.max
      )
        return value;
    }
  } catch {
    // The responsive default also works when browser storage is unavailable.
  }
  return fallback;
}

function chartTickPoints(extent: number): number[] {
  const points = [0];
  for (let n = -1; n <= Math.ceil(Math.log10(Math.max(1, extent))) + 1; n++)
    for (let k = 2; k < 20; k++) {
      const value = 0.5 * k * 10 ** n;
      if (isChartTick(value)) {
        const exact = Number(value.toFixed(1));
        points.push(exact, -exact);
      }
    }
  return points;
}

function chartTickValues(start: number, step: number, count: number) {
  return Array.from(
    { length: count + 1 },
    (_, i) => (Math.round(start * 10) + i * Math.round(step * 10)) / 10,
  );
}

export function resolveChartTicks(
  axis: ReturnType<typeof groupChartAxes>[number],
  count: 5 | 10,
  magnitude = axis.magnitude,
  preserveRange = false,
) {
  let lower = axis.min ?? Math.min(...axis.labelValues);
  let upper = axis.max ?? Math.max(...axis.labelValues);
  if (upper < lower) [lower, upper] = [upper, lower];
  const maximumInterval = chartTickStep(Math.max(0.1, magnitude), "floor");
  if (preserveRange)
    return resolvedChartTicks(
      axis,
      lower,
      upper,
      (upper - lower) / count,
      count,
      maximumInterval,
    );
  const automatic = !axis.customMin && !axis.customMax;
  if (automatic && magnitude === 0) lower = upper = 0;
  const centered = axis.unit === "A" && automatic;
  const fromZero = automatic && !centered && lower >= 0;
  const toZero = automatic && !centered && upper <= 0;
  const points = chartTickPoints(
    Math.max(Math.abs(lower), Math.abs(upper), maximumInterval * 10),
  );
  const find = (grids: 5 | 10) => {
    const high = Math.min(upper, lower + grids * maximumInterval);
    const center = (lower + high) / 2;
    let best:
      | {
          min: number;
          max: number;
          interval: number;
          covered: boolean;
          score: number;
        }
      | undefined;
    for (
      let step = Math.min(
        chartTickStep((high - lower) / grids),
        maximumInterval,
      );
      step <= maximumInterval * (1 + 1e-10);
      step = chartTickStep(step * 1.01)
    ) {
      const span = grids * step;
      const starts = centered
        ? [-span / 2]
        : fromZero
          ? [0]
          : toZero
            ? [-span]
            : [...points].sort(
                (a, b) =>
                  Math.abs(a + span / 2 - center) -
                  Math.abs(b + span / 2 - center),
              );
      let covered: typeof best;
      for (const start of starts) {
        if (!isChartTick(start)) continue;
        const ticks = chartTickValues(start, step, grids);
        const min = start;
        const max = ticks[grids];
        const covers = min <= lower + 1e-8 && max >= high - 1e-8;
        const score = Math.abs((min + max) / 2 - center);
        if (!covers && best && score >= best.score) continue;
        if (covered && score >= covered.score) continue;
        if (!ticks.every(isChartTick)) continue;
        const candidate = { min, max, interval: step, covered: covers, score };
        if (covers && (!covered || score < covered.score)) covered = candidate;
        if (
          !best ||
          score < best.score ||
          (score === best.score && span < best.max - best.min)
        )
          best = candidate;
      }
      if (covered) return covered;
    }
    return best!;
  };
  let range = find(count);
  // Five centered cells at the minimum 0.1 step would require ±0.25.
  // Ten cells preserve exact one-decimal ticks and zero at the center.
  if ((!range || !range.covered) && count === 5 && centered) {
    const expanded = find(10);
    if (expanded?.covered || !range) {
      range = expanded;
      count = 10;
    }
  }
  const { min, max, interval } = range;
  return resolvedChartTicks(axis, min, max, interval, count, maximumInterval);
}

function resolvedChartTicks(
  axis: ReturnType<typeof groupChartAxes>[number],
  min: number,
  max: number,
  interval: number,
  count: 5 | 10,
  maximumInterval: number,
) {
  const labelValues = chartTickValues(min, interval, count);
  const integerTicks = labelValues.every(
    (value) => Math.abs(value - Math.round(value)) < 1e-8,
  );
  const precision =
    Math.max(Math.abs(min), Math.abs(max)) >= 10 && integerTicks ? 0 : 1;
  const numberWidth = Math.max(
    ...labelValues.map((v) => formatAxisValue(v, "", precision).trim().length),
  );
  return {
    ...axis,
    min,
    max,
    interval,
    precision,
    labelValues,
    numberWidth,
    maximumInterval,
    gridCount: count,
  };
}

export type ResolvedChartAxis = ReturnType<typeof resolveChartTicks>;

function nearestChartGrid(
  axis: ResolvedChartAxis,
  interval: number,
  start: number,
  wholeSteps = false,
  anchor?: number,
) {
  const span = axis.gridCount * interval;
  let best: { startValue: number; endValue: number } | undefined;
  let distance = Infinity;
  for (const candidate of chartTickPoints(
    Math.max(Math.abs(start), Math.abs(start + span), span),
  )) {
    const offset = (candidate - axis.min) / interval;
    if (wholeSteps && Math.abs(offset - Math.round(offset)) > 1e-8) continue;
    const nextDistance = Math.abs(candidate - start);
    if (nextDistance >= distance - 1e-8) continue;
    const ticks = chartTickValues(candidate, interval, axis.gridCount);
    if (
      anchor !== undefined &&
      (anchor < candidate - 1e-8 || anchor > ticks[axis.gridCount] + 1e-8)
    )
      continue;
    if (!ticks.every(isChartTick)) continue;
    distance = nextDistance;
    best = { startValue: candidate, endValue: ticks[axis.gridCount] };
  }
  return best;
}

/** One wheel event selects the next legal displayed scale, skipping invalid steps. */
export function zoomChartAxis(
  axis: ResolvedChartAxis,
  anchor: number,
  direction: number,
) {
  const ratio = Math.max(0, Math.min(1, anchor));
  const point = axis.min + (axis.max - axis.min) * ratio;
  let interval = axis.interval;
  for (;;) {
    const next =
      direction > 0
        ? chartTickStep(interval * 1.01)
        : chartTickStep(interval / 1.01, "floor");
    if (next === interval || next < 0.1)
      return { startValue: axis.min, endValue: axis.max };
    interval = next;
    if (interval > axis.maximumInterval * (1 + 1e-10)) {
      if (direction > 0) return { startValue: axis.min, endValue: axis.max };
      continue;
    }
    const result = nearestChartGrid(
      axis,
      interval,
      point - ratio * axis.gridCount * interval,
      false,
      point,
    );
    if (result) return result;
  }
}

/** Resolve a damped pinch from its starting range, independent of event count. */
export function pinchChartAxis(
  axis: ResolvedChartAxis,
  anchor: number,
  initialDistance: number,
  distance: number,
) {
  const factor = Math.sqrt(
    Math.max(1, initialDistance) / Math.max(1, distance),
  );
  const target = axis.interval * factor;
  const ratio = Math.max(0, Math.min(1, anchor));
  const point = axis.min + (axis.max - axis.min) * ratio;
  let best = { startValue: axis.min, endValue: axis.max };
  let score = Math.abs(Math.log(axis.interval / target));
  for (
    let interval = 0.1;
    interval <= axis.maximumInterval * (1 + 1e-10);
    interval = chartTickStep(interval * 1.01)
  ) {
    const nextScore = Math.abs(Math.log(interval / target));
    if (nextScore >= score - 1e-8) continue;
    const range = nearestChartGrid(
      axis,
      interval,
      point - ratio * axis.gridCount * interval,
      false,
      point,
    );
    if (range) {
      best = range;
      score = nextScore;
    }
  }
  return best;
}

/** Panning preserves the displayed scale; its shifted ticks need not match the automatic formula. */
export function panChartAxis(axis: ResolvedChartAxis, steps: number) {
  const offset = Math.round(steps) * Math.round(axis.interval * 10);
  return {
    startValue: (Math.round(axis.min * 10) + offset) / 10,
    endValue: (Math.round(axis.max * 10) + offset) / 10,
  };
}

/** Keep an actual value visible without breaking exact ticks or accumulating overscroll. */
export function constrainChartAxis(
  axis: ResolvedChartAxis,
  range: { startValue: number; endValue: number },
  value: number,
  panning = false,
) {
  if (value >= range.startValue - 1e-8 && value <= range.endValue + 1e-8)
    return range;
  if (panning) {
    const steps =
      value < range.startValue
        ? Math.floor((value - axis.min) / axis.interval + 1e-8)
        : Math.ceil((value - axis.max) / axis.interval - 1e-8);
    return panChartAxis(axis, steps);
  }
  const interval = (range.endValue - range.startValue) / axis.gridCount;
  return (
    nearestChartGrid(axis, interval, range.startValue, false, value) ?? {
      startValue: axis.min,
      endValue: axis.max,
    }
  );
}

/** Exact signed ticks: |value| = 0.5*k*10^n, integer 2<=k<20, n>=-1. */
export function isChartTick(value: number): boolean {
  const absolute = Math.abs(value);
  if (absolute === 0) return true;
  if (
    !Number.isFinite(absolute) ||
    Math.abs(absolute * 10 - Math.round(absolute * 10)) > 1e-7
  )
    return false;
  const exponent = Math.floor(Math.log10(absolute) + 1e-10);
  if (exponent < -1) return false;
  const k = absolute / (0.5 * 10 ** exponent);
  return k >= 2 - 1e-8 && k < 20 - 1e-8 && Math.abs(k - Math.round(k)) < 1e-8;
}

/** Decimal 1/2/5 steps, including a hard minimum of 0.1. */
export function chartTickStep(
  value: number,
  direction: "ceil" | "floor" = "ceil",
) {
  const target = Math.max(0.1, Number.isFinite(value) ? value : 0.1);
  const scale = 10 ** Math.floor(Math.log10(target));
  const steps = [1, 2, 5, 10].map((multiple) => multiple * scale);
  const step =
    direction === "ceil"
      ? steps.find((candidate) => candidate >= target * (1 - 1e-10))!
      : steps.filter((candidate) => candidate <= target * (1 + 1e-10)).at(-1)!;
  return Math.max(0.1, Number(step.toPrecision(12)));
}

export function formatAxisValue(
  value: number,
  unit: string,
  precision = 1,
  numberWidth = 0,
) {
  const text = value.toFixed(precision);
  const number = Number(text) === 0 ? (0).toFixed(precision) : text;
  return `${number.padStart(numberWidth)} ${unit}`;
}

export function readBounds(key: string): ChartBounds {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    const result: ChartBounds = {};
    for (const name of Object.keys(measurements) as MeasurementKey[]) {
      const range =
        saved?.[name] ??
        (name === "mosTemperature" ? saved?.deviceTemperature : undefined);
      if (!range || typeof range !== "object") continue;
      const min =
        typeof range.min === "number" && Number.isFinite(range.min)
          ? range.min
          : undefined;
      const max =
        typeof range.max === "number" && Number.isFinite(range.max)
          ? range.max
          : undefined;
      if (min !== undefined && max !== undefined && min >= max) continue;
      result[name] = { min, max };
      if (
        typeof range.color === "string" &&
        /^#[0-9a-f]{6}$/i.test(range.color)
      )
        result[name]!.color = range.color;
      if (
        typeof range.width === "number" &&
        Number.isFinite(range.width) &&
        range.width >= 0.5 &&
        range.width <= 3
      )
        result[name]!.width = range.width;
      if (
        typeof range.lineOpacity === "number" &&
        Number.isFinite(range.lineOpacity) &&
        range.lineOpacity >= 0 &&
        range.lineOpacity <= 1
      )
        result[name]!.lineOpacity = range.lineOpacity;
      if (
        typeof range.areaOpacity === "number" &&
        Number.isFinite(range.areaOpacity) &&
        range.areaOpacity >= 0 &&
        range.areaOpacity <= 1
      )
        result[name]!.areaOpacity = range.areaOpacity;
    }
    return result;
  } catch {
    return {};
  }
}

export function readSharedChartBounds(): ChartBounds {
  try {
    if (localStorage.getItem("atorch-chart-bounds") !== null)
      return readBounds("atorch-chart-bounds");
  } catch {
    return {};
  }
  // Reuse the live preference when both legacy views configured one channel.
  return {
    ...readBounds("atorch-review-bounds"),
    ...readBounds("atorch-live-bounds"),
  };
}

export function filterSamples(
  rows: Telemetry[],
  from?: number,
  to?: number,
): Telemetry[] {
  if (
    (from !== undefined && !Number.isFinite(from)) ||
    (to !== undefined && !Number.isFinite(to)) ||
    (from !== undefined && to !== undefined && from > to)
  )
    return [];
  if (from === undefined && to === undefined) return rows;
  return rows.filter(
    (row) =>
      (from === undefined || row.timestamp >= from) &&
      (to === undefined || row.timestamp <= to),
  );
}

export type SampleSummary = {
  count: number;
  min: number | null;
  max: number | null;
  average: number | null;
  minCalculated?: boolean;
  maxCalculated?: boolean;
};
export function isCalculatedMeasurement(
  row: Telemetry,
  key: MeasurementKey,
): boolean {
  return (
    (key === "energy" && !!row.energyCalculated) ||
    (key === "capacity" && !!row.capacityCalculated)
  );
}
export type SampleSummaries = Partial<Record<MeasurementKey, SampleSummary>>;
const summaries = new WeakMap<Telemetry[], SampleSummaries>();

export function cacheSummaries(rows: Telemetry[], prepared: SampleSummaries) {
  summaries.set(rows, prepared);
}

export function summarizeMeasurements(rows: Telemetry[]): SampleSummaries {
  for (const key of measurementKeys) summarize(rows, key);
  return summaries.get(rows)!;
}

export function summarize(
  rows: Telemetry[],
  key: MeasurementKey,
): SampleSummary {
  let cache = summaries.get(rows);
  if (!cache) summaries.set(rows, (cache = {}));
  if (cache[key]) return cache[key]!;
  const cumulative = key === "energy" || key === "capacity";
  let count = 0,
    sum = 0,
    min = Infinity,
    max = -Infinity;
  let minCalculated = false,
    maxCalculated = false;
  for (const row of rows) {
    const value = row[key];
    if (value == null || !Number.isFinite(value)) continue;
    count++;
    if (!cumulative) sum += value;
    if (value < min) {
      min = value;
      minCalculated = isCalculatedMeasurement(row, key);
    }
    if (value > max) {
      max = value;
      maxCalculated = isCalculatedMeasurement(row, key);
    }
  }
  return (cache[key] = {
    count,
    min: count ? min : null,
    max: count ? max : null,
    average: count && !cumulative ? sum / count : null,
    ...(minCalculated ? { minCalculated: true } : {}),
    ...(maxCalculated ? { maxCalculated: true } : {}),
  });
}
