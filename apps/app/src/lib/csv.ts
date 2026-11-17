import type { Telemetry } from "./types";
import { completeRecordCounters } from "./records.ts";
import {
  cacheMeasurementPrecision,
  sourceFractionDigits,
  type MeasurementPrecision,
} from "./measurementFormat.ts";

export function csvCells(line: string): string[] {
  const cells: string[] = [];
  let text = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        text += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(text.trim());
      text = "";
    } else text += ch;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  cells.push(text.trim());
  return cells;
}

function timeText(cell: string): string {
  const text = cell.trim().replace(/^=/, "");
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function parseTimestamp(cell: string): number {
  const text = timeText(cell);
  return /^\d{12,}$/.test(text)
    ? Number(text)
    : new Date(text.replace(/[ _]/, "T")).getTime();
}

function parseDuration(cell: string): number {
  const match = /^(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(
    timeText(cell),
  );
  if (!match || (match[1] !== undefined && Number(match[2]) >= 24)) return NaN;
  return (
    ((Number(match[1] ?? 0) * 24 + Number(match[2])) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
      1000 +
    Number((match[5] ?? "").padEnd(3, "0"))
  );
}

export function parseCsv(text: string): Telemetry[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((l) =>
    /^(?:(?:\(时间\))?DATE|TIME\s*\([^)]*\))\s*,/i.test(l.trim()),
  );
  if (headerIndex < 0)
    throw new Error("未找到 DATE 或 Time 表头；请选择支持的 CSV 文件");
  const columns = csvCells(lines[headerIndex]).map((s) => s.toUpperCase());
  const relative = columns[0].startsWith("TIME");
  const startingTime = relative
    ? parseTimestamp(
        lines
          .slice(0, headerIndex)
          .map(csvCells)
          .find((cells) => cells[0].toUpperCase() === "DATETIME")?.[1] ?? "",
      )
    : undefined;
  if (relative && !Number.isFinite(startingTime))
    throw new Error("CSV 缺少有效的 DateTime 起始时间");
  const col = (pattern: RegExp) => columns.findIndex((c) => pattern.test(c));
  const fields: Record<string, number> = {
    voltage: col(/VOLTAGE|VBUS/),
    current: col(/CURRENT|IBUS/),
    power: col(/POWER/),
    resistance: col(/RESISTANCE/),
    energy: col(/E_QUANTITY/),
    capacity: col(/E_CAPACITY/),
    ntcTemperature: col(/NTC_TEMP/),
    cpuTemperature: col(/CPU_TEMP/),
    mosTemperature: col(/MOS_TEMP/),
    fanSpeed: col(/FAN_SPEED/),
  };
  if (fields.voltage < 0 || fields.current < 0)
    throw new Error("CSV 缺少电压或电流列");
  const entries = Object.entries(fields);
  const elapsedColumn = col(/^ELAPSED_MS$/);
  const segmentColumn = col(/^SEGMENT_ID$/);
  const temperatureColumn = col(/DEVICE_TEMP/);
  const rows: Telemetry[] = [];
  const precision: MeasurementPrecision = {};
  let ordered = true;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = csvCells(lines[i]);
    const elapsedMs = relative ? parseDuration(cells[0]) : undefined;
    const timestamp = relative
      ? startingTime! + elapsedMs!
      : parseTimestamp(cells[0]);
    if (!Number.isFinite(timestamp)) throw new Error(`第 ${i + 1} 行时间无效`);
    const row: Record<string, number | null> = { timestamp };
    if (elapsedMs !== undefined) row.elapsedMs = elapsedMs;
    if (!relative && elapsedColumn >= 0 && cells[elapsedColumn]?.trim()) {
      const value = Number(cells[elapsedColumn]);
      if (!Number.isFinite(value) || value < 0)
        throw new Error(`第 ${i + 1} 行采样时长无效`);
      row.elapsedMs = value;
    }
    if (segmentColumn >= 0 && cells[segmentColumn]?.trim()) {
      const value = Number(cells[segmentColumn]);
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`第 ${i + 1} 行记录分段无效`);
      row.segmentId = value;
    }
    for (const [field, index] of entries) {
      const required = field === "voltage" || field === "current";
      const value =
        index < 0 || !cells[index]?.trim() ? null : Number(cells[index]);
      if (
        (required && value === null) ||
        (value !== null && !Number.isFinite(value)) ||
        (index >= cells.length && index >= 0)
      )
        throw new Error(`第 ${i + 1} 行 ${field} 数据无效`);
      row[field] = value;
      if (value !== null && index >= 0) {
        const key = field as keyof MeasurementPrecision;
        precision[key] = Math.max(
          precision[key] ?? 0,
          sourceFractionDigits(cells[index]),
        );
      }
    }
    if (temperatureColumn >= 0 && cells[temperatureColumn]?.trim()) {
      const value = Number(cells[temperatureColumn]);
      if (!Number.isFinite(value))
        throw new Error(`第 ${i + 1} 行设备温度数据无效`);
      // Earlier exports used a separate name for the same MOS sensor. Prefer
      // an explicit MOS reading when both columns are present.
      if (row.mosTemperature == null) {
        row.mosTemperature = value;
        precision.mosTemperature = Math.max(
          precision.mosTemperature ?? 0,
          sourceFractionDigits(cells[temperatureColumn]),
        );
      }
    }
    if (rows.length && timestamp < rows[rows.length - 1].timestamp)
      ordered = false;
    const sample = row as unknown as Telemetry;
    sample.power ??= Number(row.voltage) * Number(row.current);
    sample.running = null;
    sample.status = 0;
    rows.push(sample);
  }
  if (rows.length === 0) throw new Error("CSV 没有有效采样数据");
  if (!ordered) rows.sort((a, b) => a.timestamp - b.timestamp);
  cacheMeasurementPrecision(rows, precision);
  return completeRecordCounters(rows);
}

export function exportCsv(rows: Telemetry[]): string {
  const timeline = rows.some(
    (row) => row.elapsedMs !== undefined || row.segmentId !== undefined,
  );
  const header =
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),RESISTANCE(Ω),E_QUANTITY(Wh),E_CAPACITY(mAh),NTC_TEMP(℃),CPU_TEMP(℃),MOS_TEMP(℃),FAN_SPEED(RPM)" +
    (timeline ? ",ELAPSED_MS,SEGMENT_ID" : "");
  return (
    "\uFEFF" +
    header +
    "\r\n" +
    rows
      .map((t) =>
        [
          new Date(t.timestamp).toISOString(),
          t.voltage,
          t.current,
          t.power,
          t.resistance,
          t.energy,
          t.capacity,
          t.ntcTemperature,
          t.cpuTemperature,
          t.mosTemperature,
          t.fanSpeed,
          ...(timeline ? [t.elapsedMs, t.segmentId] : []),
        ].join(","),
      )
      .join("\r\n")
  );
}

export async function readCsv(file: File): Promise<Telemetry[]> {
  const bytes = await file.arrayBuffer();
  return parseCsvBytes(new Uint8Array(bytes));
}

export function parseCsvBytes(bytes: Uint8Array): Telemetry[] {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\uFFFD")) text = new TextDecoder("gb18030").decode(bytes);
  return parseCsv(text);
}

export function parseCsvBase64(encoded: string): Telemetry[] {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return parseCsvBytes(bytes);
}

export function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
