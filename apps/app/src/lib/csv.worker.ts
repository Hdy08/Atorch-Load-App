/// <reference lib="webworker" />
import { parseCsvBase64, readCsv } from "./csv";
import { packedChartData } from "./chartData";
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
    const chart = packedChartData(rows);
    const summaries = summarizeMeasurements(rows);
    const transfer = [values.buffer];
    if (chart) {
      transfer.push(chart.clock.buffer);
      if (chart.elapsed !== chart.clock) transfer.push(chart.elapsed.buffer);
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
