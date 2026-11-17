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
      areaOpacity?: number;
    }
  >
>;

export function chartAxisRange(
  key: MeasurementKey,
  rows: Telemetry[],
  custom?: { min?: number; max?: number },
): { min?: number; max?: number } {
  if (custom?.min !== undefined || custom?.max !== undefined)
    return { min: custom.min, max: custom.max };
  let low = 0;
  let high = 0;
  const observed = summarize(rows, key);
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
      chartAxisRange(key, rows, bounds[key]),
    );
    let observedMin = Infinity;
    let observedMax = -Infinity;
    const lows: number[] = [];
    const highs: number[] = [];
    for (const [keyIndex, key] of group.keys.entries()) {
      const stats = summarize(rows, key);
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

export function resolveChartTicks(
  axis: ReturnType<typeof groupChartAxes>[number],
  count: 5 | 10,
) {
  let min = axis.min ?? Math.min(...axis.labelValues);
  let max = axis.max ?? Math.max(...axis.labelValues);
  if (max <= min) max = min + 1;
  const niceStep = (value: number) => {
    const scale = 10 ** Math.floor(Math.log10(Math.max(0.1, value)));
    const multiple = [1, 2, 2.5, 4, 5, 10].find(
      (n) => n * scale >= value - 1e-10,
    )!;
    return Math.max(0.1, Math.ceil(multiple * scale * 10 - 1e-8) / 10);
  };
  if (!(axis.customMin && axis.customMax)) {
    let step = niceStep((max - min) / count);
    if (axis.unit === "A" && !axis.customMin && !axis.customMax) {
      // Five intervals put zero halfway between two grid lines. Keep the
      // endpoints symmetric and representable with one decimal place.
      if (count === 5) step = Math.ceil(step * 5 - 1e-8) / 5;
      max = (step * count) / 2;
      min = -max;
    } else if (axis.customMax && !axis.customMin) {
      min = max - step * count;
    } else if (axis.customMin) {
      max = min + step * count;
    } else {
      const observedMax = max;
      let start = Math.floor(min / step + 1e-8) * step;
      while (start + step * count < observedMax - 1e-8) {
        step = niceStep(step * 1.01);
        start = Math.floor(min / step + 1e-8) * step;
      }
      min = start;
      max = min + step * count;
    }
  }
  // Integer labels need integer tick positions on automatic axes as well.
  // Explicit user bounds stay authoritative, including fractional endpoints.
  if (max >= 10 - 1e-8 && !axis.customMin && !axis.customMax) {
    let step = Math.ceil((max - min) / count - 1e-8);
    if (axis.unit === "A") {
      if (count === 5) step = Math.ceil(step / 2) * 2;
      max = (step * count) / 2;
      min = -max;
    } else {
      const upper = max;
      let start = Math.floor(min / step + 1e-8) * step;
      while (start + step * count < upper - 1e-8) {
        step++;
        start = Math.floor(min / step + 1e-8) * step;
      }
      min = start;
      max = start + step * count;
    }
  }
  const interval = (max - min) / count;
  const precision = max >= 10 - 1e-8 ? 0 : 1;
  const labelValues = Array.from(
    { length: count + 1 },
    (_, i) => min + interval * i,
  );
  const numberWidth = Math.max(
    ...labelValues.map((v) => formatAxisValue(v, "", precision).trim().length),
  );
  return { ...axis, min, max, interval, precision, labelValues, numberWidth };
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
