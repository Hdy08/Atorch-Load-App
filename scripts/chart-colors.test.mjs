import { test } from "node:test";
import assert from "node:assert/strict";
import { chartColors } from "../apps/app/src/lib/chartColors.ts";

function linearRgb(hex) {
  return [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}
function luminance(hex) {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function oklab(hex) {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

for (const background of ["#ffffff", "#292929"]) {
  test(`chart presets spread perceptual colors and retain line contrast on ${background}`, () => {
    const colors = Object.values(chartColors(background));
    assert.equal(colors.length, 10);
    assert.equal(new Set(colors).size, 10);
    for (const [index, color] of colors.entries()) {
      const light = luminance(color),
        base = luminance(background);
      const contrast =
        (Math.max(light, base) + 0.05) / (Math.min(light, base) + 0.05);
      assert.ok(contrast >= 3, `${color} contrast ${contrast}`);
      const lab = oklab(color);
      for (const other of colors.slice(index + 1)) {
        const right = oklab(other);
        const distance = Math.hypot(...lab.map((value, i) => value - right[i]));
        assert.ok(
          distance >= 0.1,
          `${color} / ${other}: OKLab distance ${distance}`,
        );
      }
    }
  });
}
