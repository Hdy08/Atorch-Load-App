import type { Theme } from "@fluentui/react-components";
import type { MeasurementKey } from "./analysis";

// Canvas charts cannot resolve CSS variables. Read their colors from the same,
// unmodified Fluent theme object supplied to FluentProvider.
const measurementColorTokens = {
  voltage: "colorBrandForeground1",
  current: "colorPaletteTealBorderActive",
  power: "colorPaletteMarigoldForeground2",
  resistance: "colorPalettePurpleBorderActive",
  energy: "colorPaletteGoldForeground2",
  capacity: "colorPaletteRedForeground1",
  cpuTemperature: "colorPaletteMagentaBorderActive",
  ntcTemperature: "colorPaletteLightTealBorderActive",
  mosTemperature: "colorPaletteDarkOrangeForeground1",
  fanSpeed: "colorPaletteForestBorderActive",
} as const satisfies Record<MeasurementKey, keyof Theme>;

export function measurementColor(theme: Theme, key: MeasurementKey): string {
  return theme[measurementColorTokens[key]];
}

export function chartPalette(theme: Theme): string[] {
  return (Object.keys(measurementColorTokens) as MeasurementKey[]).map((key) =>
    measurementColor(theme, key),
  );
}
