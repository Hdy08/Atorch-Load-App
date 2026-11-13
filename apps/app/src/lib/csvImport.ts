import {
  csvRowWidth,
  unpackCsvRows,
  type CsvImportRequest,
  type CsvImportResponse,
} from "./csvTransfer";
import type { Telemetry } from "./types";
import { cacheChartData } from "./chartData";
import { cacheSummaries } from "./analysis";

export async function importCsv(input: CsvImportRequest): Promise<Telemetry[]> {
  const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = await new Promise<
      Exclude<CsvImportResponse, { error: string }>
    >((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<CsvImportResponse>) => {
        if ("error" in event.data) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message || "CSV 后台读取失败"));
      };
      worker.onmessageerror = () => reject(new Error("CSV 后台数据传输失败"));
      worker.postMessage(input);
    });
    const { values, chart, summaries } = result;
    const count = values.length / csvRowWidth;
    const rows = new Array<Telemetry>(count);
    // Bound UI work per turn while materialising the original, complete rows.
    for (let start = 0; start < count; start += 8192) {
      unpackCsvRows(values, rows, start, Math.min(start + 8192, count));
      if (start + 8192 < count)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (chart) cacheChartData(rows, chart);
    cacheSummaries(rows, summaries);
    return rows;
  } finally {
    worker.terminate();
  }
}
