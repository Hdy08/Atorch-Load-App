import { measurementKeys, type SampleSummaries } from "./analysis.ts";
import type { Telemetry } from "./types";
import type { ChartIndex } from "./chartData";
import type { MeasurementPrecision } from "./measurementFormat";

// One transferable buffer avoids cloning hundreds of thousands of JS objects
// between the worker and WebView. NaN represents an absent optional value.
export const csvRowWidth = measurementKeys.length + 4;

export function packCsvRows(rows: Telemetry[]): Float64Array {
  const values = new Float64Array(rows.length * csvRowWidth);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let offset = i * csvRowWidth;
    values[offset++] = row.timestamp;
    values[offset++] = row.elapsedMs ?? NaN;
    values[offset++] = row.segmentId ?? NaN;
    values[offset++] =
      (row.energyCalculated ? 1 : 0) | (row.capacityCalculated ? 2 : 0);
    for (const key of measurementKeys) values[offset++] = row[key] ?? NaN;
  }
  return values;
}

export function unpackCsvRows(
  values: Float64Array,
  rows: Telemetry[],
  start: number,
  end: number,
): void {
  for (let i = start; i < end; i++) {
    let offset = i * csvRowWidth;
    const timestamp = values[offset++];
    const elapsedMs = values[offset++];
    const segmentId = values[offset++];
    const flags = values[offset++];
    const row = { timestamp, running: null, status: 0 } as Telemetry;
    if (!Number.isNaN(elapsedMs)) row.elapsedMs = elapsedMs;
    if (!Number.isNaN(segmentId)) row.segmentId = segmentId;
    if (flags & 1) row.energyCalculated = true;
    if (flags & 2) row.capacityCalculated = true;
    for (const key of measurementKeys) {
      const value = values[offset++];
      (row as unknown as Record<string, number | null>)[key] = Number.isNaN(
        value,
      )
        ? null
        : value;
    }
    rows[i] = row;
  }
}

export type CsvImportRequest = { base64: string } | { file: File };
export type CsvImportResponse =
  | {
      values: Float64Array;
      chart?: ChartIndex;
      summaries: SampleSummaries;
      precision: MeasurementPrecision;
    }
  | { error: string };
