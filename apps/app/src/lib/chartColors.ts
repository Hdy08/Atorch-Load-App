import type { MeasurementKey } from "./analysis";

// Chart colors span hue and lightness independently of the interface accent.
// Separate ramps keep thin lines readable on both Fluent canvas backgrounds.
const light = {
  voltage: "#0072ce",
  current: "#498200",
  power: "#c45a00",
  resistance: "#8b4fd0",
  energy: "#008080",
  capacity: "#d32f49",
  cpuTemperature: "#8d7d40",
  mosTemperature: "#bb238d",
  ntcTemperature: "#7b4925",
  fanSpeed: "#404040",
} satisfies Record<MeasurementKey, string>;

const dark = {
  voltage: "#54a9ff",
  current: "#80ce48",
  power: "#ffa23c",
  resistance: "#b293ff",
  energy: "#42d6d1",
  capacity: "#ff6d7e",
  cpuTemperature: "#e1de38",
  mosTemperature: "#f58ad0",
  ntcTemperature: "#b7875c",
  fanSpeed: "#b5bec9",
} satisfies Record<MeasurementKey, string>;

export function chartColors(
  background: string,
): Record<MeasurementKey, string> {
  const value = Number.parseInt(background.slice(1), 16);
  const brightness =
    (value >> 16) * 0.2126 +
    ((value >> 8) & 255) * 0.7152 +
    (value & 255) * 0.0722;
  return brightness < 128 ? dark : light;
}
