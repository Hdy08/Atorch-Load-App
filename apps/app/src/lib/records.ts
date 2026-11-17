import type { Telemetry } from "./types";
import { copyMeasurementPrecision } from "./measurementFormat.ts";

const valid = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);
const completed = new WeakMap<Telemetry[], Telemetry[]>();

/** Fill absent counters before filtering so a selected range retains its totals. */
export function completeRecordCounters(rows: Telemetry[]): Telemetry[] {
  const cached = completed.get(rows);
  if (cached) return cached;
  if (rows.every((row) => valid(row.energy) && valid(row.capacity))) {
    completed.set(rows, rows);
    return rows;
  }
  let energy = 0;
  let capacity = 0;
  const result = rows.map((row, index) => {
    const previous = rows[index - 1];
    const interval = previous
      ? valid(row.elapsedMs) && valid(previous.elapsedMs)
        ? row.elapsedMs - previous.elapsedMs
        : row.timestamp - previous.timestamp
      : 0;
    const dt = Number.isFinite(interval) ? Math.max(0, interval) : 0;
    if (previous) {
      if (valid(previous.power) && valid(row.power))
        energy +=
          (((Math.abs(previous.power) + Math.abs(row.power)) / 2) * dt) /
          3_600_000;
      if (valid(previous.current) && valid(row.current))
        capacity +=
          (((Math.abs(previous.current) + Math.abs(row.current)) / 2) * dt) /
          3_600;
    }
    const energyMissing = !valid(row.energy);
    const capacityMissing = !valid(row.capacity);
    if (!energyMissing) energy = row.energy!;
    if (!capacityMissing) capacity = row.capacity!;
    if (!energyMissing && !capacityMissing) return row;
    return {
      ...row,
      energy,
      capacity,
      ...(energyMissing ? { energyCalculated: true } : {}),
      ...(capacityMissing ? { capacityCalculated: true } : {}),
    };
  });
  completed.set(rows, result);
  completed.set(result, result);
  copyMeasurementPrecision(rows, result);
  return result;
}
