import type { MeasurementKey } from "./analysis";
import type { Telemetry } from "./types";

export type MeasurementPrecision = Partial<Record<MeasurementKey, number>>;

// CSV precision belongs to the dataset. Keeping it outside individual samples
// avoids duplicating metadata across hundreds of thousands of rows.
const precisions = new WeakMap<Telemetry[], MeasurementPrecision>();
const devicePrecision: Record<MeasurementKey, number> = {
  voltage: 3,
  current: 3,
  power: 3,
  resistance: 3,
  energy: 3,
  capacity: 3,
  cpuTemperature: 3,
  ntcTemperature: 3,
  mosTemperature: 3,
  fanSpeed: 3,
};

export function sourceFractionDigits(text: string): number {
  const match = /^[+-]?(?:\d+\.?|\d*\.)(\d*)(?:e([+-]?\d+))?$/i.exec(
    text.trim(),
  );
  if (!match) return 0;
  return Math.min(100, Math.max(0, match[1].length - Number(match[2] ?? 0)));
}

export function cacheMeasurementPrecision(
  rows: Telemetry[],
  precision: MeasurementPrecision,
): void {
  precisions.set(rows, precision);
}

export function cacheDeviceMeasurementPrecision(
  rows: Telemetry[],
  transport: string | undefined,
): void {
  cacheMeasurementPrecision(
    rows,
    transport === "bluetooth"
      ? {
          ...devicePrecision,
          voltage: 1,
          capacity: 0,
          mosTemperature: 0,
        }
      : devicePrecision,
  );
}

export function measurementPrecision(
  rows: Telemetry[],
): Record<MeasurementKey, number> {
  return { ...devicePrecision, ...precisions.get(rows) };
}

export function copyMeasurementPrecision(
  source: Telemetry[],
  target: Telemetry[],
): void {
  const precision = precisions.get(source);
  if (precision) precisions.set(target, precision);
}

export function formatMeasurement(
  value: number | null | undefined,
  digits: number,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  // Pad the decimal representation directly. toFixed(20) can otherwise turn
  // an original 5.1 into 5.09999999999999964473 in a high-precision CSV column.
  const [coefficient, exponent] = Math.abs(value).toString().split("e");
  const decimal = coefficient.indexOf(".");
  const significant = coefficient.replace(".", "");
  const position =
    (decimal < 0 ? significant.length : decimal) + Number(exponent ?? 0);
  const integer =
    position <= 0 ? "0" : significant.slice(0, position).padEnd(position, "0");
  const fraction =
    position < 0
      ? "0".repeat(-position) + significant
      : significant.slice(position);
  if (fraction.length <= digits)
    return `${value < 0 ? "-" : ""}${integer}${digits ? `.${fraction.padEnd(digits, "0")}` : ""}`;
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}
