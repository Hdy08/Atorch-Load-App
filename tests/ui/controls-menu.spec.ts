import { test, expect, type Page } from "@playwright/test";
import { chooseMenu, expectMenuOptions } from "./menu";

async function fixture(page: Page, mobile = false) {
  await page.addInitScript((mobile) => {
    if (mobile)
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36",
      });
    localStorage.setItem(
      "atorch-appearance",
      JSON.stringify({ scale: mobile ? 75 : 100, theme: "dark" }),
    );
    const sample = {
      timestamp: 1794902400000,
      voltage: 5,
      current: 0.1,
      power: 0.5,
      resistance: 50,
      energy: 0,
      capacity: 0,
      cpuTemperature: 25,
      mosTemperature: 26,
      ntcTemperature: 27,
      fanSpeed: 0,
      running: false,
      status: 0,
    };
    const rows = [sample, { ...sample, timestamp: sample.timestamp + 1000 }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "get_system_accent") return "#8764b8";
          if (
            command === "get_system_theme" ||
            command === "set_window_theme" ||
            command === "window_action"
          )
            return false;
          if (command === "get_history") return rows;
          if (command === "get_snapshot")
            return {
              connected: true,
              device: {
                path: "menu-test",
                name: "BW150 · 模拟设备",
                transport: "usb",
              },
              settings: {
                mode: 0,
                target: 0.1,
                cutoffVoltage: 2.5,
                overCurrent: 10,
                overPower: 400,
                fullVoltage: 4.2,
                cutoffCurrent: 0.05,
                mosLimit: 100,
                ntcLimit: 100,
                limitHours: 2,
                limitMinutes: 0,
              },
              telemetry: rows[1],
              connectedAt: 1,
              lastReportAt: rows[1].timestamp,
              sampleCount: 2,
              samplingPaused: false,
              usbSampleRateHz: 1,
              logs: [],
              recording: null,
              error: null,
            };
          return null;
        },
      },
    });
  }, mobile);
  await page.goto("/");
}

for (const mobile of [false, true]) {
  test(`selection buttons fit their longest option and accent input fits its text on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    const theme = page.getByRole("button", { name: "主题", exact: true });
    const first = (await theme.boundingBox())!;
    await chooseMenu(theme, "light");
    expect((await theme.boundingBox())!.width).toBeCloseTo(first.width, 1);
    await chooseMenu(theme, "system");
    expect((await theme.boundingBox())!.width).toBeCloseTo(first.width, 1);
    for (const button of await page.locator(".menu-select:visible").all()) {
      const sizes = await button.evaluate((element) => {
        const label = element.querySelector(".menu-select-label")!;
        const style = getComputedStyle(element);
        return {
          width: element.getBoundingClientRect().width,
          label: label.getBoundingClientRect().width,
          scale:
            element.getBoundingClientRect().width /
            (element as HTMLElement).offsetWidth,
          parent: element.parentElement!.getBoundingClientRect().width,
          padding:
            parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        };
      });
      expect(sizes.width / sizes.scale).toBeLessThan(210);
      expect(sizes.width).toBeLessThan(sizes.parent - 16);
      expect(sizes.width - sizes.label).toBeGreaterThan(24 * sizes.scale);
      await expect(button.locator(".menu-select-value")).toHaveCSS(
        "text-align",
        "start",
      );
    }
    const color = page.getByRole("textbox", { name: "强调色", exact: true });
    const root = color.locator("..");
    const metrics = await color.evaluate((input) => {
      const element = input as HTMLInputElement;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = getComputedStyle(element).font;
      return {
        width: element.clientWidth,
        text: context.measureText(element.value).width,
        font: getComputedStyle(element).font,
        fontFamily: getComputedStyle(element).fontFamily,
        minWidth: getComputedStyle(element).minWidth,
        flex: getComputedStyle(element).flex,
        computedWidth: getComputedStyle(element).width,
        offset: element.offsetWidth,
        box: element.getBoundingClientRect().toJSON(),
        border: getComputedStyle(element).border,
        padding: getComputedStyle(element).padding,
        gutter: getComputedStyle(element).scrollbarGutter,
        bodyZoom: getComputedStyle(document.body).zoom,
        fontSize: getComputedStyle(element).fontSize,
      };
    });
    expect(metrics.width, JSON.stringify(metrics)).toBeGreaterThanOrEqual(
      metrics.text,
    );
    const rootBox = (await root.boundingBox())!;
    expect(rootBox.width).toBeGreaterThanOrEqual(mobile ? 85 : 110);
    expect(rootBox.width).toBeLessThan(mobile ? 150 : 190);
    const colorBox = (await color.boundingBox())!;
    expect(colorBox.x - rootBox.x).toBeGreaterThanOrEqual(mobile ? 9 : 12);
    const picker = (await page
      .getByRole("button", { name: "强调色取色器", exact: true })
      .boundingBox())!;
    expect(picker.x + picker.width).toBeLessThanOrEqual(
      rootBox.x + rootBox.width + 1,
    );
    await page.screenshot({
      path: info.outputPath("appearance-compact.png"),
      animations: "disabled",
    });
    await page.getByRole("tab", { name: "记录", exact: true }).click();
    const mode = page.getByRole("button", { name: "自动记录", exact: true });
    const before = (await mode.boundingBox())!.width;
    await chooseMenu(mode, "threshold");
    expect((await mode.boundingBox())!.width).toBeCloseTo(before, 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(mobile ? 390 : 1440);
  });

  test(`curve opacity defaults, validates and is shared with history on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    const chartStyles = () =>
      page.evaluate(async () => {
        const resource = performance
          .getEntriesByType("resource")
          .find((entry) => entry.name.includes("/echarts_core.js"))!;
        const core = await import(resource.name);
        const chart = core.getInstanceByDom(
          document.querySelector(".trend-chart"),
        );
        return chart.getOption().series.map((series: any) => ({
          line: series.lineStyle.opacity,
          fill: series.areaStyle?.opacity ?? 0,
        }));
      });
    await expect(page.locator(".trend-chart canvas")).toBeVisible();
    await expect.poll(chartStyles).toEqual([
      { line: 1, fill: 0 },
      { line: 1, fill: 0 },
    ]);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    const line = page.getByRole("spinbutton", {
      name: "电压曲线不透明度",
      exact: true,
    });
    const fill = page.getByRole("spinbutton", {
      name: "电压阴影不透明度",
      exact: true,
    });
    for (const input of await page
      .locator('input[aria-label$="曲线不透明度"]')
      .all())
      await expect(input).toHaveValue("100");
    await expect(fill).toHaveValue("0");
    const lineBox = (await line.boundingBox())!;
    const fillBox = (await fill.boundingBox())!;
    expect(lineBox.y).toBeCloseTo(fillBox.y, 1);
    expect(lineBox.x + lineBox.width).toBeLessThan(fillBox.x);
    for (const value of ["-1", "101", ""]) {
      await line.fill(value);
      await page.getByRole("button", { name: "应用更改", exact: true }).click();
      await expect(
        page.getByText("电压的曲线不透明度无效；范围为 0–100%", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await line.fill("25");
    await fill.fill("60");
    await page
      .getByRole("spinbutton", { name: "电流曲线不透明度", exact: true })
      .fill("0");
    await page
      .locator(".axis-card")
      .first()
      .screenshot({ path: info.outputPath("curve-opacity.png") });
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("atorch-chart-bounds")!),
      ),
    ).toEqual({
      voltage: { lineOpacity: 0.25, areaOpacity: 0.6 },
      current: { lineOpacity: 0 },
    });
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await expect.poll(chartStyles).toEqual([
      { line: 0.25, fill: 0.6 },
      { line: 0, fill: 0 },
    ]);
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    await expect.poll(chartStyles).toEqual([
      { line: 0.25, fill: 0.6 },
      { line: 0, fill: 0 },
    ]);
    await page.reload();
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    await expect(line).toHaveValue("25");
    await expect(fill).toHaveValue("60");
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    await expect(line).toHaveValue("100");
    await expect(fill).toHaveValue("0");
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    expect(
      await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
    ).toBe("{}");
  });
}

test("Fluent selection menus expose checked choices, keyboard navigation and focus restoration", async ({
  page,
}, info) => {
  await fixture(page);
  const time = page.getByRole("button", { name: "曲线时间坐标", exact: true });
  await expect(time).toHaveText("绝对时间");
  await expectMenuOptions(time, ["绝对时间", "相对时间"]);
  await chooseMenu(time, "elapsed");
  await page.reload();
  await expect(time).toHaveText("相对时间");
  await chooseMenu(time, "clock");
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  const theme = page.getByRole("button", { name: "主题", exact: true });
  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menuitemradio", { name: "深色", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: info.outputPath("fluent-menu-desktop.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitemradio", { name: "浅色", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "深色", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(theme).toHaveText("深色");
  await expect(theme).toBeFocused();
  await expect(page.locator("select, [role=combobox]")).toHaveCount(0);
});

for (const mobile of [false, true])
  test(`unified numeric inputs preserve drafts, units and spin bounds on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    const scale = page.getByRole("spinbutton", {
      name: "界面缩放",
      exact: true,
    });
    await scale.press("ArrowUp");
    await expect(scale).toHaveValue(mobile ? "76" : "101");
    await scale.fill("200");
    await expect(
      page.getByRole("button", { name: "增加界面缩放", exact: true }),
    ).toBeDisabled();
    await scale.press("ArrowDown");
    await expect(scale).toHaveValue("199");
    await page
      .getByRole("button", { name: "减少界面缩放", exact: true })
      .click();
    await expect(scale).toHaveValue("198");
    const scaleRoot = page.locator(".numeric-input").filter({ has: scale });
    await expect(scaleRoot.locator(".numeric-input-unit")).toHaveText("%");
    await scaleRoot.screenshot({ path: info.outputPath("scale-input.png") });
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
    const min = page.getByRole("spinbutton", {
      name: "电压最小值",
      exact: true,
    });
    await expect(min).toHaveAttribute("placeholder", "自动");
    await min.fill("-2.35");
    await min.press("Tab");
    await expect(min).toHaveValue("-2.35");
    await min.press("ArrowUp");
    await expect(min).toHaveValue("-2.25");
    await min.fill("");
    await min.press("Tab");
    await expect(min).toHaveValue("");
    await min.press("ArrowUp");
    await expect(min).toHaveValue("0.1");
    await min.press("ArrowDown");
    await expect(min).toHaveValue("0.0");
    const width = page.getByRole("spinbutton", {
      name: "电压线宽",
      exact: true,
    });
    await width.press("ArrowUp");
    await expect(width).toHaveValue("1.5");
    await width.fill("3");
    await expect(
      page.getByRole("button", { name: "增加电压线宽", exact: true }),
    ).toBeDisabled();
    await page.getByRole("tab", { name: "记录", exact: true }).click();
    await chooseMenu(
      page.getByRole("button", { name: "自动记录", exact: true }),
      "device",
    );
    const delay = page.getByRole("spinbutton", {
      name: "启动延迟",
      exact: true,
    });
    await delay.press("ArrowUp");
    await expect(delay).toHaveValue("0.1");
    await page
      .getByRole("switch", { name: "启动时开始", exact: true })
      .uncheck();
    await expect(delay).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "增加启动延迟", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "减少启动延迟", exact: true }),
    ).toBeDisabled();
    await chooseMenu(
      page.getByRole("button", { name: "自动记录", exact: true }),
      "threshold",
    );
    await page.getByRole("switch", { name: "开始阈值", exact: true }).check();
    await expectMenuOptions(
      page.getByRole("button", { name: "开始参数", exact: true }),
      ["电压", "电流", "功率"],
    );
    await page.screenshot({ path: info.outputPath("recording-controls.png") });
    for (const input of await page
      .locator(
        "input:not([type=color]):not([type=file]):not([type=checkbox]):not([type=radio])",
      )
      .all()) {
      if (
        !(await input.isVisible()) ||
        (await input.getAttribute("aria-label")) === "强调色"
      )
        continue;
      await expect(input).toHaveAttribute("role", "spinbutton");
      const root = input.locator("..");
      await expect(root).toHaveClass(/numeric-input/);
      await expect(root.locator("button")).toHaveCount(2);
      const box = (await root.boundingBox())!;
      const unit = (await root.locator(".numeric-input-unit").boundingBox())!;
      const up = (await root
        .locator(".fui-SpinButton__incrementButton")
        .boundingBox())!;
      expect(unit.x + unit.width).toBeLessThanOrEqual(up.x + 0.5);
      expect(up.x + up.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(mobile ? 390 : 1440);
  });

for (const mobile of [false, true])
  test(`chart actions become icons only when their row is too narrow (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }, info) => {
    await fixture(page, mobile);
    for (const history of [false, true]) {
      if (history)
        await page
          .getByRole("button", { name: "数据记录", exact: true })
          .click();
      const actions = page.locator(".chart-image-actions");
      for (const width of [1440, mobile ? 320 : 390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await actions.scrollIntoViewIfNeeded();
        if (width === 1440) {
          await expect(actions).not.toHaveClass(/icon-only/);
          for (const label of await actions
            .locator(".chart-action-label")
            .all())
            await expect(label).toBeVisible();
        } else {
          await expect(actions).toHaveClass(/icon-only/);
          for (const label of await actions
            .locator(".chart-action-label")
            .all())
            await expect(label).toBeHidden();
          for (const name of ["导出", "截图", "复原", "全屏"])
            await expect(
              actions.getByRole("button", { name, exact: true }),
            ).toBeVisible();
          const rects = await actions
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getBoundingClientRect().toJSON()),
            );
          expect(
            Math.max(...rects.map((rect) => rect.y)) -
              Math.min(...rects.map((rect) => rect.y)),
          ).toBeLessThan(1);
          const bounds = (await actions.boundingBox())!;
          expect(rects.at(-1)!.right).toBeLessThanOrEqual(
            bounds.x + bounds.width + 1,
          );
          await actions
            .getByRole("button", { name: "全屏", exact: true })
            .hover();
          await expect(page.getByRole("tooltip")).toHaveText("全屏");
          await actions.screenshot({
            path: info.outputPath(`${history ? "history" : "live"}-icons.png`),
          });
          await page.mouse.move(0, 0);
        }
      }
    }
  });

for (const mobile of [false, true])
  test(`fullscreen toolbar spacing matches its top inset on ${mobile ? "mobile" : "desktop"}`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "全屏曲线", exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "退出", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const resource = performance
            .getEntriesByType("resource")
            .find((entry) => entry.name.includes("/echarts_core.js"))!;
          const core = await import(resource.name);
          const toolbar = document.querySelector<HTMLElement>(
            ".chart-fullscreen-toolbar",
          )!;
          const chart = core.getInstanceByDom(
            document.querySelector(".trend-chart"),
          );
          return (
            chart.getOption().grid[0].top -
            toolbar.offsetTop * 2 -
            toolbar.offsetHeight
          );
        }),
      )
      .toBe(0);
    await page.screenshot({ path: info.outputPath("fullscreen-spacing.png") });
    await dialog.getByRole("button", { name: "退出", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "复原", exact: true }),
    ).toBeVisible();
  });
