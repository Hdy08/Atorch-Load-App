import {
  createDarkTheme,
  createLightTheme,
  webDarkTheme,
  webLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";
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
  mosTemperature: "colorPaletteDarkOrangeForeground1",
  ntcTemperature: "colorPaletteLightTealBorderActive",
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

/** Supply the full brand ramp to Fluent's theme factories; neutral/status tokens stay stock. */
export function accentTheme(dark: boolean, color: string): Theme {
  if (color.toLowerCase() === "#0f6cbd")
    return dark ? webDarkTheme : webLightTheme;
  const channels = [1, 3, 5].map(
    (start) => parseInt(color.slice(start, start + 2), 16) / 255,
  );
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const luminance = (rgb: number[]) =>
    rgb
      .map(linear)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  // Brand80 carries white button labels. Preserve readable contrast even for a pale picked color.
  while (luminance(channels) > 0.183)
    for (let i = 0; i < 3; i++) channels[i] *= 0.98;
  const hex = (rgb: number[]) =>
    "#" +
    rgb
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const ramp = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => {
      const shade = (i + 1) * 10;
      const rgb =
        shade <= 80
          ? channels.map((v) => v * (shade / 80) ** 0.85)
          : channels.map((v) => v + (1 - v) * ((shade - 80) / 90));
      return [shade, hex(rgb)];
    }),
  ) as BrandVariants;
  return dark ? createDarkTheme(ramp) : createLightTheme(ramp);
}
