/// <reference lib="webworker" />
import { parseCsvBase64, readCsv } from "./csv";
import { indexedChartData, chartIndexBuffers } from "./chartData";
import { summarizeMeasurements } from "./analysis";
import {
  packCsvRows,
  type CsvImportRequest,
  type CsvImportResponse,
} from "./csvTransfer";

self.onmessage = async (event: MessageEvent<CsvImportRequest>) => {
  try {
    const rows =
      "file" in event.data
        ? await readCsv(event.data.file)
        : parseCsvBase64(event.data.base64);
    const values = packCsvRows(rows);
    const summaries = summarizeMeasurements(rows);
    const chart = indexedChartData(rows);
    const transfer = [values.buffer];
    if (chart) {
      transfer.push(...chartIndexBuffers(chart));
    }
    self.postMessage({ values, chart, summaries } satisfies CsvImportResponse, {
      transfer,
    });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    } satisfies CsvImportResponse);
  }
};
