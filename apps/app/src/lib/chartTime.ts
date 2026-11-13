import type { Telemetry } from "./types";

export type ChartTimeMode = "clock" | "elapsed";

export function readChartTimeMode(): ChartTimeMode {
  return localStorage.getItem("atorch-chart-time-mode") === "elapsed"
    ? "elapsed"
    : "clock";
}

export function sampleElapsedMs(row: Telemetry, origin: number): number {
  return row.elapsedMs ?? row.timestamp - origin;
}

export function formatElapsedTime(
  milliseconds: number,
  precise = false,
): string {
  const ticks = Math.max(0, Math.round(milliseconds / (precise ? 10 : 1000)));
  const seconds = precise ? Math.floor(ticks / 100) : ticks;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}${precise ? `.${pad(ticks % 100)}` : ""}`;
}

export function formatClockTime(milliseconds: number, precise = false): string {
  const date = new Date(
    precise ? Math.round(milliseconds / 10) * 10 : milliseconds,
  );
  const time = date.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return precise
    ? `${time}.${String(Math.floor(date.getMilliseconds() / 10)).padStart(2, "0")}`
    : time;
}
