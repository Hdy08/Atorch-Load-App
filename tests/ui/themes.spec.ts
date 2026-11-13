import { expect, test, type Page } from "@playwright/test";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { mkdir } from "node:fs/promises";

// Explicit UI-only IPC fixture. Commands that could touch hardware are rejected.
async function fixture(page: Page, dark: boolean, sampleCount = 61) {
  await page.addInitScript(
    ({ dark, sampleCount }) => {
      if (!localStorage.getItem("atorch-theme")) {
        localStorage.setItem("atorch-theme", dark ? "dark" : "light");
      }
      const connectedAt = Date.now() - (sampleCount - 1) * 1000;
      const settings = {
        mode: 0,
        target: 1,
        cutoffVoltage: 2.499999523162842,
        overCurrent: 16,
        overPower: 400,
        ntcLimit: 100,
        mosLimit: 100,
        fullVoltage: 4.2,
        cutoffCurrent: 0.05,
        voltageCalibration: 1,
        currentCalibration: 1,
        temperatureCalibration: 1,
        language: 1,
        brightness: 9,
        standbyBrightness: 4,
        standbySeconds: 60,
        limitHours: 2,
        limitMinutes: 0,
      };
      const samples = Array.from({ length: sampleCount }, (_, index) => ({
        timestamp: connectedAt + index * 1000,
        voltage: 12 + Math.sin(index / 8) * 0.05,
        current: 1 + Math.sin(index / 6) * 0.01,
        power: 12,
        capacity: 6599.362,
        energy: 129.664,
        resistance: 12,
        cpuTemperature: 31,
        ntcTemperature: 20.5,
        mosTemperature: 26,
        fanSpeed: 0,
        running: false,
        status: 0,
      }));
      Object.assign(window, {
        isTauri: true,
        themeConnected: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "get_snapshot") {
              const connected = (window as any).themeConnected;
              return {
                connected,
                device: connected
                  ? {
                      path: "theme-ui-fixture",
                      name: "BW150 · 界面验证数据",
                      serial: "UI fixture",
                      vendorId: 0x0483,
                      productId: 0x5750,
                    }
                  : null,
                telemetry: connected
                  ? { ...samples.at(-1), timestamp: Date.now() }
                  : null,
                settings: connected ? settings : null,
                sampleCount: samples.length,
                connectedAt,
                lastReportAt: Date.now(),
                recording: null,
                error: null,
                logs: [],
              };
            }
            if (command === "get_history") return samples;
            if (command === "save_png") {
              (window as any).themeImage = args.dataUrl;
              return "fixture/theme-chart.png";
            }
            throw new Error(`Unexpected theme UI command: ${command}`);
          },
        },
      });
    },
    { dark, sampleCount },
  );
  await page.goto("/");
  await expect(
    page
      .locator(".sidebar-device")
      .getByRole("button", { name: "管理设备", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
}

const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

test("sidebar switches directly to its narrow width and device management matches navigation", async ({
  page,
}) => {
  await fixture(page, true);
  for (const width of [
    1440, 1201, 1200, 1100, 901, 900, 850, 651, 1201, 1200,
  ]) {
    await page.setViewportSize({ width, height: 1050 });
    await expect(page.locator(".sidebar")).toHaveCSS(
      "width",
      width > 1200 ? "228px" : "72px",
    );
    const manager = page.getByRole("button", { name: "管理设备", exact: true });
    const navigation = page.getByRole("button", {
      name: "数据记录",
      exact: true,
    });
    const properties = [
      "min-height",
      "font-size",
      "font-weight",
      "line-height",
      "border-radius",
      "background-color",
      "color",
      "justify-content",
    ];
    const styles = (element: Element, properties: string[]) =>
      Object.fromEntries(
        properties.map((property) => [
          property,
          getComputedStyle(element).getPropertyValue(property),
        ]),
      );
    expect(await manager.evaluate(styles, properties)).toEqual(
      await navigation.evaluate(styles, properties),
    );
    const left = await manager.boundingBox(),
      top = await navigation.boundingBox();
    expect(left!.x).toBe(top!.x);
    expect(left!.width).toBe(top!.width);
    if (width <= 1200) {
      await expect(page.locator(".device-manager-label")).toBeHidden();
      await expect(
        page.locator(".device-manager-button .nav-item-icon"),
      ).toBeVisible();
    } else await expect(page.locator(".device-manager-label")).toBeVisible();
  }
});

async function chartStyle(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((resource) => resource.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const core = await import(url);
    const chart = core.getInstanceByDom(document.querySelector(".trend-chart"));
    const options = chart.getOption();
    return {
      foreground: options.xAxis[0].axisLabel.color,
      tooltip: options.tooltip[0].backgroundColor,
      grid: options.yAxis[0].splitLine.lineStyle.color,
      slider: options.dataZoom[1].backgroundColor,
      series: options.series.map((series: any) => series.lineStyle.color),
    };
  });
}

for (const dark of [false, true]) {
  const name = dark ? "dark" : "light";
  const theme = dark ? webDarkTheme : webLightTheme;
  const nextTheme = dark ? webLightTheme : webDarkTheme;

  test(`stock Fluent theme, control states and chart export (${name})`, async ({
    page,
  }) => {
    await fixture(page, dark);
    const keys = Object.keys(theme);
    const actualTokens = await page
      .locator(".theme-root")
      .first()
      .evaluate((el, keys) => {
        const style = getComputedStyle(el);
        return Object.fromEntries(
          keys.map((key) => [key, style.getPropertyValue(`--${key}`).trim()]),
        );
      }, keys);
    expect(actualTokens).toEqual(
      Object.fromEntries(
        Object.entries(theme).map(([key, value]) => [key, String(value)]),
      ),
    );
    await expect(page.locator(".app")).toHaveCSS(
      "background-color",
      rgb(theme.colorNeutralBackground2),
    );
    await expect(page.locator(".app")).toHaveCSS(
      "color",
      rgb(theme.colorNeutralForeground1),
    );
    await expect(page.locator(".device-connection-status")).toHaveCSS(
      "color",
      rgb(theme.colorStatusSuccessForeground1),
    );
    await expect(page.locator(".sidebar-device-name strong")).toHaveCSS(
      "font-size",
      theme.fontSizeBase300,
    );
    await expect(page.locator(".device-manager-button")).toHaveCSS(
      "font-size",
      theme.fontSizeBase300,
    );
    await expect(page.locator(".device-manager-button .fui-Badge")).toHaveCount(
      0,
    );
    for (const card of await page.locator(".fui-Card").all()) {
      await expect(card).toHaveCSS(
        "background-color",
        rgb(theme.colorNeutralBackground1),
      );
      await expect(card).toHaveCSS("border-radius", theme.borderRadiusMedium);
      await expect(card).toHaveCSS("padding-top", "12px");
      for (const edge of ["right", "bottom", "left"])
        await expect(card).toHaveCSS(`padding-${edge}`, "12px");
      if (await card.evaluate((el) => el.classList.contains("metric")))
        await expect(card).toHaveCSS("gap", "4px");
    }
    const button = page.getByRole("button", { name: "启动负载", exact: true });
    await expect(button).toHaveCSS(
      "background-color",
      rgb(theme.colorBrandBackground),
    );
    await expect(button).toHaveCSS("border-radius", theme.borderRadiusMedium);
    await button.hover();
    await expect(button).toHaveCSS(
      "background-color",
      rgb(theme.colorBrandBackgroundHover),
    );
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      (window as any).themeConnected = false;
    });
    await expect(button).toBeDisabled();
    await expect(page.locator(".device-connection-status")).toHaveCSS(
      "color",
      rgb(theme.colorStatusDangerForeground1),
    );
    await expect(button).toHaveCSS(
      "background-color",
      rgb(theme.colorNeutralBackgroundDisabled),
    );
    await expect(button).toHaveCSS(
      "color",
      rgb(theme.colorNeutralForegroundDisabled),
    );
    await page.evaluate(() => {
      (window as any).themeConnected = true;
    });
    await expect(button).toBeEnabled();
    await expect
      .poll(() => chartStyle(page))
      .toEqual({
        foreground: theme.colorNeutralForeground3,
        tooltip: theme.colorNeutralBackground1,
        grid: theme.colorNeutralStroke2,
        slider: theme.colorNeutralBackground3,
        series: [
          theme.colorBrandForeground1,
          theme.colorPaletteTealBorderActive,
        ],
      });
    for (const [key, color] of [
      ["voltage", theme.colorBrandForeground1],
      ["current", theme.colorPaletteTealBorderActive],
      ["power", theme.colorPaletteMarigoldForeground2],
      ["resistance", theme.colorPalettePurpleBorderActive],
      ["energy", theme.colorPaletteGoldForeground2],
      ["capacity", theme.colorPaletteRedForeground1],
    ]) {
      const card = page.locator(`.metric[data-measurement="${key}"]`);
      await expect(card.locator(".metric-number")).toHaveCSS(
        "color",
        rgb(color),
      );
      await expect(card.locator(".metric-unit")).toHaveCSS("color", rgb(color));
      await expect(card.locator(".metric-symbol")).toHaveCSS(
        "color",
        rgb(color),
      );
      const tint = await card
        .locator(".metric-symbol")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(tint).toMatch(/^color\(srgb /);
      const components = tint.match(/[\d.]+/g)!.map(Number);
      for (let index = 0; index < 3; index++)
        expect(components[index]).toBeCloseTo(
          Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255,
          5,
        );
      expect(components[3]).toBe(0.16);
    }

    // Actual export button; verify the PNG's background, not a second test renderer.
    await page.getByRole("button", { name: "截图", exact: true }).click();
    await expect(
      page.getByText("曲线图片已保存：fixture/theme-chart.png"),
    ).toBeVisible();
    const pixel = await page.evaluate(async () => {
      const image = new Image();
      image.src = (window as any).themeImage;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    const expectedRgb = rgb(theme.colorNeutralBackground1)
      .match(/\d+/g)!
      .map(Number);
    expect(pixel).toEqual([...expectedRgb, 255]);

    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    await expect(page.getByLabel("电压颜色", { exact: true })).toHaveValue(
      theme.colorBrandForeground1,
    );
    await page.getByLabel("电压颜色", { exact: true }).fill("#aa33cc");
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page.getByRole("switch", { name: "深色主题", exact: true }).click();
    await expect(page.locator(".app")).toHaveCSS(
      "background-color",
      rgb(nextTheme.colorNeutralBackground2),
    );
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await axesAndLabels(page)).axes.find((axis) => axis.unit === "V")
            ?.color,
      )
      .toBe("#aa33cc");
    await expect
      .poll(async () => (await chartStyle(page)).series)
      .toEqual(["#aa33cc", nextTheme.colorPaletteTealBorderActive]);
    const voltageCard = page.locator('.metric[data-measurement="voltage"]');
    for (const part of [".metric-number", ".metric-unit", ".metric-symbol"])
      await expect(voltageCard.locator(part)).toHaveCSS(
        "color",
        rgb("#aa33cc"),
      );
    await page.reload();
    await expect(page.locator(".app")).toHaveCSS(
      "background-color",
      rgb(nextTheme.colorNeutralBackground2),
    );
    await expect
      .poll(async () => (await chartStyle(page)).series)
      .toEqual(["#aa33cc", nextTheme.colorPaletteTealBorderActive]);
    for (const part of [".metric-number", ".metric-unit", ".metric-symbol"])
      await expect(voltageCard.locator(part)).toHaveCSS(
        "color",
        rgb("#aa33cc"),
      );
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await expect
      .poll(async () => (await chartStyle(page)).series)
      .toEqual([
        nextTheme.colorBrandForeground1,
        nextTheme.colorPaletteTealBorderActive,
      ]);
    for (const part of [".metric-number", ".metric-unit", ".metric-symbol"])
      await expect(voltageCard.locator(part)).toHaveCSS(
        "color",
        rgb(nextTheme.colorBrandForeground1),
      );
  });

  for (const width of [390, 768, 1440, 1920]) {
    test(`clean layout fits every page (${name}, ${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1050 });
      await fixture(page, dark);
      for (const label of ["实时监控", "数据记录", "设备设置", "应用设置"]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect(
          page.getByRole("heading", { name: label, exact: true, level: 1 }),
        ).toBeVisible();
        await expect(
          page.locator(".page-heading p, .nav-label, .metric-bottom"),
        ).toHaveCount(0);
        if (label === "实时监控") {
          await expect(page.locator(".record-card, .chart-footer")).toHaveCount(
            0,
          );
          for (const name of [
            "曲线设置",
            "温度曲线",
            "容量 / 电量",
            "容量曲线",
          ])
            await expect(
              page.getByRole("button", { name, exact: true }),
            ).toHaveCount(0);
          const metricsBox = await page.locator(".metrics").boundingBox();
          const chartBox = await page.locator(".chart-card").boundingBox();
          expect(chartBox!.width).toBeCloseTo(metricsBox!.width, 0);
          for (const select of await page
            .locator(".chart-toolbar .fui-Select")
            .all()) {
            const root = (await select.boundingBox())!;
            const icon = (await select
              .locator(".fui-Select__icon")
              .boundingBox())!;
            expect(icon.y).toBeGreaterThanOrEqual(root.y);
            expect(icon.y + icon.height).toBeLessThanOrEqual(
              root.y + root.height,
            );
          }
          const record = page.locator(".chart-card .chart-image-actions");
          await expect(
            record.getByRole("button", { name: "暂停", exact: true }),
          ).toBeVisible();
          await expect(
            record.getByRole("button", { name: "清空", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: /^(开始|停止)记录$/ }),
          ).toHaveCount(0);
          await expect(
            record.getByRole("button", { name: "导出", exact: true }),
          ).toBeVisible();
          expect((await record.boundingBox())!.x).toBeLessThan(
            chartBox!.x + 20,
          );
          await expect(page.locator(".metrics > .metric")).toHaveCount(6);
          const titleStyle = await page
            .getByRole("heading", { name: "实时曲线", exact: true })
            .evaluate((el) => {
              const style = getComputedStyle(el);
              return {
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                fontWeight: style.fontWeight,
                fontFamily: style.fontFamily,
                color: style.color,
              };
            });
          for (const title of await page.locator(".metric-title h2").all()) {
            const actual = await title.evaluate((el) => {
              const style = getComputedStyle(el);
              return {
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                fontWeight: style.fontWeight,
                fontFamily: style.fontFamily,
                color: style.color,
              };
            });
            expect(actual).toEqual(titleStyle);
          }
          await expect(
            page.getByRole("heading", { name: "累计数据", exact: true }),
          ).toHaveCount(0);
          const cards = await page.locator(".metric").evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              return {
                top: box.top,
                height: box.height,
                overflow: element.scrollWidth > element.clientWidth,
              };
            }),
          );
          expect(
            cards.every((card) => card.height <= 88 && !card.overflow),
            JSON.stringify(cards),
          ).toBe(true);
          if (width >= 1440)
            expect(new Set(cards.map((card) => card.top)).size).toBe(1);
          if (width === 390 || width === 1440) {
            await mkdir("artifacts/sampling-timeline", { recursive: true });
            await page.locator(".metrics").screenshot({
              path: `artifacts/sampling-timeline/${name}-${width}-cards.png`,
            });
          }
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          label,
        ).toBeLessThanOrEqual(width);
        await expect(
          page.locator(
            ".brand, .topbar, .eyebrow, .workspace-footer, .sidebar-bottom",
          ),
        ).toHaveCount(0);
        await expect(
          page.getByText("ATORCH / ELECTRONIC LOAD", { exact: true }),
        ).toHaveCount(0);
        if (label === "设备设置") {
          await expect(
            page.getByRole("tab", { name: "参数与维护", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(
            page.getByRole("switch", { name: "深色主题", exact: true }),
          ).toHaveCount(0);
          await expect(
            page
              .locator("nav")
              .getByRole("button", { name: "固件更新", exact: true }),
          ).toHaveCount(0);
        }
        if (label === "应用设置") {
          await expect(
            page.getByRole("tab", { name: "外观", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(
            page.getByRole("switch", { name: "深色主题", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("tablist", { name: "设备设置分类" }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("heading", { name: "负载与保护", exact: true }),
          ).toHaveCount(0);
        }
        if (
          width !== 768 &&
          ["实时监控", "设备设置", "应用设置"].includes(label)
        ) {
          await mkdir("artifacts/ui-multi-axis", { recursive: true });
          const screen =
            label === "实时监控"
              ? "monitor"
              : label === "设备设置"
                ? "device-settings"
                : "app-settings";
          await page.screenshot({
            path: `artifacts/ui-multi-axis/${name}-${width}-${screen}.png`,
            fullPage: true,
          });
        }
      }
      await page.getByRole("tab", { name: "曲线", exact: true }).click();
      await expect(
        page.getByRole("tabpanel", { name: "曲线", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("form", { name: "曲线与坐标设置" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `artifacts/ui-multi-axis/${name}-${width}-curve-settings.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "设备设置", exact: true }).click();
      await page.getByRole("tab", { name: "固件更新", exact: true }).click();
      await expect(
        page.getByRole("tabpanel", { name: "固件更新", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "设备设置", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.getByRole("tab", { name: "参数与维护", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "负载与保护", exact: true }),
      ).toBeVisible();
    });
  }
}

async function axesAndLabels(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((resource) => resource.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const core = await import(url);
    const dom = document.querySelector(".trend-chart")!;
    const chart = core.getInstanceByDom(dom);
    const options = chart.getOption();
    return {
      width: dom.clientWidth,
      axes: options.yAxis.map((axis: any, index: number) => {
        const boxes: {
          x: number;
          y: number;
          width: number;
          height: number;
          text: string;
        }[] = [];
        const view = chart.getViewOfComponentModel(
          chart.getModel().getComponent("yAxis", index),
        );
        view.group.traverse((element: any) => {
          if (
            element.type !== "text" ||
            element.ignore ||
            element.invisible ||
            !String(element.style.text).endsWith(` ${axis.id}`)
          )
            return;
          const rect = element.getBoundingRect().clone();
          rect.applyTransform(element.getComputedTransform());
          boxes.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            text: element.style.text,
          });
        });
        return {
          unit: axis.id,
          name: axis.name,
          show: axis.show,
          position: axis.position,
          offset: axis.offset,
          tick: axis.axisLabel.formatter(1),
          interval: axis.interval,
          max: axis.max,
          splitNumber: axis.splitNumber,
          tickCount: chart
            .getModel()
            .getComponent("yAxis", index)
            .axis.scale.getTicks().length,
          fontFamily: axis.axisLabel.fontFamily,
          color: axis.axisLabel.color,
          boxes,
        };
      }),
      series: options.series.map((series: any) => ({
        name: series.name,
        yAxisIndex: series.yAxisIndex,
        color: series.lineStyle.color,
        width: series.lineStyle.width,
        areaOpacity: series.areaStyle?.opacity ?? 0,
        areaColor: series.areaStyle?.color,
      })),
    };
  });
}

for (const dark of [false, true]) {
  test(`all curve colors are distinct and preset/native pickers update the color field (${dark ? "dark" : "light"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1050 });
    await fixture(page, dark);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    const colors = await page
      .locator('.axis-color-input input[type="text"]')
      .evaluateAll((inputs) =>
        inputs.map((el) => (el as HTMLInputElement).value.toLowerCase()),
      );
    expect(colors).toHaveLength(10);
    expect(new Set(colors).size).toBe(10);
    const presets = page.getByRole("radiogroup", {
      name: "电压预设颜色",
      exact: true,
    });
    await expect(presets.getByRole("radio")).toHaveCount(10);
    await presets.getByRole("radio").last().click();
    await expect(page.getByLabel("电压颜色", { exact: true })).toHaveValue(
      colors[9],
    );
    const nativePicker = page.locator(
      'input[type="color"][aria-label="电压取色值"]',
    );
    // The actual system picker is outside browser automation. Verify its trigger,
    // then dispatch the same native change event as a chosen system color.
    await nativePicker.evaluate((el) =>
      el.addEventListener("click", (event) => {
        event.preventDefault();
        (window as any).nativeColorPickerOpened = (
          event.target as HTMLInputElement
        ).type;
      }),
    );
    const colorButton = page.getByRole("button", {
      name: "电压取色器",
      exact: true,
    });
    const inputBox = (await page
      .getByLabel("电压颜色", { exact: true })
      .boundingBox())!;
    const buttonBox = (await colorButton.boundingBox())!;
    expect(buttonBox.x).toBeGreaterThan(inputBox.x);
    await colorButton.focus();
    await colorButton.press("Enter");
    expect(
      await page.evaluate(() => (window as any).nativeColorPickerOpened),
    ).toBe("color");
    await nativePicker.evaluate((el) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(el, "#1a2b3c");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.getByLabel("电压颜色", { exact: true })).toHaveValue(
      "#1a2b3c",
    );
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    await expect(page.getByLabel("电压颜色", { exact: true })).toHaveValue(
      "#1a2b3c",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });
}

test("live and history share bounds, styles, fill opacity and chart height after reload and reset", async ({
  page,
}) => {
  await fixture(page, true);
  expect((await axesAndLabels(page)).series.map((s) => s.areaOpacity)).toEqual([
    0, 0,
  ]);
  expect((await axesAndLabels(page)).series.map((s) => s.width)).toEqual([
    1, 1,
  ]);
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  await expect(page.getByLabel("曲线设置范围", { exact: true })).toHaveCount(0);
  const opacityInputs = page.locator('input[aria-label$="阴影不透明度"]');
  for (const input of await page.locator('input[aria-label$="线宽"]').all())
    await expect(input).toHaveValue("1");
  await expect(opacityInputs).toHaveCount(10);
  for (const input of await opacityInputs.all())
    await expect(input).toHaveValue("0");
  for (const value of ["-1", "101", ""]) {
    await page.getByLabel("电压阴影不透明度", { exact: true }).fill(value);
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    await expect(
      page.getByText("电压的阴影不透明度无效；范围为 0–100%", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
    ).toBe("{}");
  }
  await page.getByLabel("电压最小值", { exact: true }).fill("0");
  await page.getByLabel("电压最大值", { exact: true }).fill("50");
  await page.getByLabel("电压颜色", { exact: true }).fill("#aa33cc");
  await page.getByLabel("电压线宽", { exact: true }).fill("1.5");
  await page.getByLabel("电压阴影不透明度", { exact: true }).fill("25");
  await page.getByLabel("电流阴影不透明度", { exact: true }).fill("60");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  const savedToast = page.locator(".fui-Toast");
  await expect(savedToast).toContainText("已保存");
  await expect(page.locator('.curve-settings [role="status"]')).toHaveCount(0);
  await expect(page.locator(".fui-Toaster.app-notifications")).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(savedToast).toHaveCount(0, { timeout: 4000 });
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("atorch-chart-bounds")!),
  );
  expect(saved).toEqual({
    voltage: {
      min: 0,
      max: 50,
      color: "#aa33cc",
      width: 1.5,
      areaOpacity: 0.25,
    },
    current: { areaOpacity: 0.6 },
  });
  const checkChart = async () => {
    await expect(page.locator(".trend-chart canvas")).toBeVisible();
    const data = await axesAndLabels(page);
    expect(data.series.map((s) => s.areaOpacity)).toEqual([0.25, 0.6]);
    expect(data.series[0]).toMatchObject({
      color: "#aa33cc",
      width: 1.5,
      areaColor: "#aa33cc",
    });
    expect(data.axes[0].max).toBe(50);
    expect(data.axes[0].color).toBe("#aa33cc");
  };
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await checkChart();
  const handle = page.getByRole("separator", {
    name: "调整曲线高度",
    exact: true,
  });
  await handle.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "1000");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await checkChart();
  await expect(handle).toHaveAttribute("aria-valuenow", "1000");
  await handle.press("Home");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  await page.reload();
  await checkChart();
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  await expect(
    page.getByLabel("电压阴影不透明度", { exact: true }),
  ).toHaveValue("25");
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(
    page.getByLabel("电压阴影不透明度", { exact: true }),
  ).toHaveValue("0");
  expect(
    await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
  ).toBe("{}");
  for (const view of ["实时监控", "数据记录"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect
      .poll(async () =>
        (await axesAndLabels(page)).series.map((s) => s.areaOpacity),
      )
      .toEqual([0, 0]);
    expect((await axesAndLabels(page)).series.map((s) => s.width)).toEqual([
      1, 1,
    ]);
  }
});

test("energy precedes capacity in cards, selectors, settings and review tables", async ({
  page,
}) => {
  await fixture(page, true);
  expect(
    await page
      .locator(".metrics .metric")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-measurement")),
      ),
  ).toEqual([
    "voltage",
    "current",
    "power",
    "resistance",
    "energy",
    "capacity",
  ]);
  const selector = page.getByRole("group", { name: "曲线参数", exact: true });
  const labels = await selector.innerText();
  expect(labels.indexOf("电量 (Wh)")).toBeLessThan(
    labels.indexOf("容量 (mAh)"),
  );
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  const headings = await page.locator(".curve-settings h2").allTextContents();
  expect(headings.indexOf("电量")).toBeLessThan(headings.indexOf("容量"));
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  // Click in reverse order: the review table still uses the presentation order.
  await page.getByRole("checkbox", { name: "容量 (mAh)", exact: true }).check();
  await page.getByRole("checkbox", { name: "电量 (Wh)", exact: true }).check();
  const statistics = await page
    .getByRole("table", { name: "采样统计", exact: true })
    .innerText();
  expect(statistics.indexOf("电量 / Wh")).toBeLessThan(
    statistics.indexOf("容量 / mAh"),
  );
  const columns = await page
    .getByRole("table", { name: "采样明细", exact: true })
    .getByRole("columnheader")
    .allTextContents();
  expect(columns.indexOf("电量 / Wh")).toBeLessThan(
    columns.indexOf("容量 / mAh"),
  );
});

test("live chart defaults to all data and retains an optional recent time window", async ({
  page,
}) => {
  await fixture(page, true, 601);
  const range = page.getByRole("combobox", {
    name: "曲线时间范围",
    exact: true,
  });
  await expect(range).toHaveValue("all");
  const dataCount = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((name) => name.includes("/echarts_core.js"))!;
      const core = await import(url);
      return core
        .getInstanceByDom(document.querySelector(".trend-chart"))
        .getOption().series[0].data.length;
    });
  await expect.poll(dataCount).toBe(601);
  await range.selectOption("300");
  await expect.poll(dataCount).toBe(301);
  await range.selectOption("all");
  await expect.poll(dataCount).toBe(601);
  await page.reload();
  await expect(range).toHaveValue("all");
  await expect.poll(dataCount).toBe(601);
});

for (const width of [390, 1440]) {
  test(`all selected units render readable shared axes in selection order (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1050 });
    await fixture(page, true);
    const selector = page.getByRole("group", { name: "曲线参数", exact: true });
    await expect(selector.getByRole("checkbox")).toHaveCount(10);
    for (const checkbox of await selector.getByRole("checkbox").all())
      await checkbox.check();
    const result = await axesAndLabels(page);
    expect(result.axes.map((axis) => axis.unit)).toEqual([
      "V",
      "A",
      "W",
      "Ω",
      "Wh",
      "mAh",
      "°C",
      "RPM",
    ]);
    expect(result.axes.map((axis) => axis.position)).toEqual([
      "left",
      "left",
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
    ]);
    expect(result.axes.map((axis) => axis.color)).toEqual([
      webDarkTheme.colorBrandForeground1,
      webDarkTheme.colorPaletteTealBorderActive,
      webDarkTheme.colorPaletteMarigoldForeground2,
      webDarkTheme.colorPalettePurpleBorderActive,
      webDarkTheme.colorPaletteGoldForeground2,
      webDarkTheme.colorPaletteRedForeground1,
      webDarkTheme.colorNeutralForeground3,
      webDarkTheme.colorPaletteForestBorderActive,
    ]);
    for (const axis of result.axes) {
      expect(axis.show).toBe(true);
      expect(axis.name).toBe("");
      expect(axis.tick.trim()).toBe(
        `${axis.max >= 10 ? "1" : "1.0"} ${axis.unit}`,
      );
      expect(axis.splitNumber).toBe(5);
      expect(axis.tickCount).toBe(6);
      expect(axis.fontFamily).toContain("Consolas");
      expect(axis.boxes.length).toBeGreaterThan(0);
      for (const box of axis.boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(result.width);
      }
    }
    const horizontal = result.axes.map((axis) => ({
      unit: axis.unit,
      min: Math.min(...axis.boxes.map((box) => box.x)),
      max: Math.max(...axis.boxes.map((box) => box.x + box.width)),
    }));
    for (let index = 1; index < horizontal.length; index++)
      expect(horizontal[index].min).toBeGreaterThan(horizontal[index - 1].max);
    expect(
      new Set(
        result.series
          .filter((series) => series.name.includes("温度"))
          .map((series) => series.yAxisIndex),
      ).size,
    ).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width === 390) {
      const scroll = page.locator(".chart-scroll");
      expect(
        await scroll.evaluate((element) => element.scrollWidth),
      ).toBeGreaterThan(
        await scroll.evaluate((element) => element.clientWidth),
      );
      await scroll.evaluate(
        (element) => (element.scrollLeft = element.scrollWidth),
      );
      expect(
        await scroll.evaluate((element) => element.scrollLeft),
      ).toBeGreaterThan(0);
      await scroll.evaluate((element) => (element.scrollLeft = 0));
    }
    await mkdir("artifacts/ui-multi-axis", { recursive: true });
    await page.screenshot({
      path: `artifacts/ui-multi-axis/dark-${width}-all-units.png`,
      fullPage: true,
    });
    // Retain the clicked order, rather than sorting axes back into the checkbox order.
    for (const name of [
      "电压 (V)",
      "电流 (A)",
      "功率 (W)",
      "电阻 (Ω)",
      "容量 (mAh)",
      "电量 (Wh)",
      "CPU 温度 (°C)",
      "探头温度 (°C)",
      "MOS 温度 (°C)",
    ])
      await selector.getByRole("checkbox", { name, exact: true }).uncheck();
    for (const name of [
      "电量 (Wh)",
      "CPU 温度 (°C)",
      "电压 (V)",
      "电流 (A)",
      "探头温度 (°C)",
    ])
      await selector.getByRole("checkbox", { name, exact: true }).check();
    const reordered = await axesAndLabels(page);
    expect(reordered.axes.map((axis) => axis.unit)).toEqual([
      "RPM",
      "Wh",
      "°C",
      "V",
      "A",
    ]);
    expect(reordered.axes.map((axis) => axis.position)).toEqual([
      "left",
      "left",
      "left",
      "right",
      "right",
    ]);
  });
}

test.describe("chart height adjustment", () => {
  test.use({ hasTouch: true });
  for (const width of [390, 1440]) {
    test(`chart bottom handle resizes, switches grid and persists (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1400 });
      await fixture(page, true);
      const selector = page.getByRole("group", {
        name: "曲线参数",
        exact: true,
      });
      for (const checkbox of await selector.getByRole("checkbox").all())
        await checkbox.check();
      const handle = page.getByRole("separator", {
        name: "调整曲线高度",
        exact: true,
      });
      const initialHeight = Number(await handle.getAttribute("aria-valuenow"));
      expect(
        (await axesAndLabels(page)).axes.every((axis) => axis.tickCount === 6),
      ).toBe(true);
      await handle.scrollIntoViewIfNeeded();
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      if (width === 390) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let delta = 20; delta <= 320; delta += 20)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + delta }],
          });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.detach();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 320, { steps: 16 });
        await page.mouse.up();
      }
      await expect(handle).toHaveAttribute(
        "aria-valuenow",
        String(initialHeight + 320),
      );
      await expect
        .poll(async () =>
          (await axesAndLabels(page)).axes.map((axis) => axis.tickCount),
        )
        .toEqual(Array(8).fill(11));
      const resized = await axesAndLabels(page);
      for (const axis of resized.axes) {
        expect(axis.splitNumber).toBe(10);
        // The padded monospace label box has the same width and origin for
        // every tick, including the right-hand axes and negative numbers.
        expect(
          Math.max(...axis.boxes.map((b) => b.x)) -
            Math.min(...axis.boxes.map((b) => b.x)),
        ).toBeLessThan(1);
        expect(
          Math.max(...axis.boxes.map((b) => b.width)) -
            Math.min(...axis.boxes.map((b) => b.width)),
        ).toBeLessThan(1);
      }
      await mkdir("artifacts/chart-resize", { recursive: true });
      await page.screenshot({
        path: `artifacts/chart-resize/tall-${width}.png`,
        fullPage: true,
      });
      await page.reload();
      await expect(handle).toHaveAttribute(
        "aria-valuenow",
        String(initialHeight + 320),
      );
      await expect(
        selector.getByRole("checkbox", { checked: true }),
      ).toHaveCount(10);
      await handle.press("Home");
      await expect(handle).toHaveAttribute("aria-valuenow", "240");
      await expect
        .poll(async () =>
          (await axesAndLabels(page)).axes.map((axis) => axis.tickCount),
        )
        .toEqual(Array(8).fill(6));
      await handle.press("ArrowDown");
      await expect(handle).toHaveAttribute("aria-valuenow", "260");
      await handle.press("End");
      await expect(handle).toHaveAttribute("aria-valuenow", "1000");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    });
  }
});
