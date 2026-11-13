import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(page: Page, mode = 0, dark = false) {
  await page.addInitScript(
    ({ mode, dark }) => {
      localStorage.setItem("atorch-theme", dark ? "dark" : "light");
      const settings = {
        mode,
        target: [1.234, 5.67, 12.34, 10.1][mode],
        cutoffVoltage: 2.55,
        overCurrent: 16.2,
        overPower: 250.1,
        fullVoltage: 4.2,
        cutoffCurrent: 0.05,
        voltageCalibration: 1,
        currentCalibration: 1,
        temperatureCalibration: 1,
        brightness: 9,
        standbyBrightness: 4,
        standbySeconds: 60,
        ntcLimit: 100,
        mosLimit: 100,
        limitHours: 2,
        limitMinutes: 0,
        language: 1,
      };
      const calls: any[] = [];
      Object.assign(window, {
        isTauri: true,
        loadCalls: calls,
        loadSettings: settings,
        failLoadKind: "",
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "get_history") return [];
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "load-ui-fixture",
                  name: "BW150 · 界面测试数据",
                  transport: "usb",
                },
                settings: { ...settings },
                telemetry: {
                  timestamp: Date.now(),
                  voltage: 12,
                  current: 0,
                  power: 0,
                  energy: 0,
                  capacity: 0,
                  resistance: 0,
                  running: false,
                  status: 0,
                },
                connectedAt: 1,
                lastReportAt: Date.now(),
                sampleCount: 0,
                logs: [],
                recording: null,
                error: null,
              };
            if (command === "send_command") {
              calls.push(args.command);
              await new Promise((resolve) => setTimeout(resolve, 100));
              if ((window as any).failLoadKind === args.command.kind)
                throw new Error("设备未确认此项设置");
              (settings as any)[args.command.kind] = args.command.value;
              return;
            }
            throw new Error(`Unexpected load UI fixture command: ${command}`);
          },
        },
      });
    },
    { mode, dark },
  );
  await page.goto("/");
  await expect(page.locator(".load-parameters .load-parameter")).toHaveCount(5);
  await expect(
    page.getByText("运行状态以设备返回为准", { exact: true }),
  ).toHaveCount(0);
}

function parameter(page: Page, label: string) {
  const input = page.getByRole("spinbutton", { name: label, exact: true });
  return { input, row: page.locator(".load-parameter").filter({ has: input }) };
}

for (const width of [390, 1440]) {
  test(`device settings share continuous sliders, numeric steps and validated limits (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1050 });
    await fixture(page, 0, true);
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await expect(page.locator(".settings-grid .load-parameter")).toHaveCount(
      11,
    );
    await expect(
      page.getByText("校准前请准备参考仪表；修改将写入设备。", { exact: true }),
    ).toHaveCount(0);
    for (const [label, kind, min, max, step, digits, unit] of [
      ["充电上限电压", "fullVoltage", 0, 100, 0.1, 2, "V"],
      ["充电截止电流", "cutoffCurrent", 0, 20, 0.1, 2, "A"],
      ["探头温度上限", "ntcLimit", 0, 100, 1, 0, "°C"],
      ["MOS 温度上限", "mosLimit", 0, 100, 1, 0, "°C"],
      ["工作亮度", "brightness", 0, 9, 1, 0, ""],
      ["待机亮度", "standbyBrightness", 0, 9, 1, 0, ""],
      ["待机延时", "standbySeconds", 10, 60, 1, 0, "秒"],
    ] as const) {
      const { input, row } = parameter(page, label);
      const slider = row.getByRole("slider", {
        name: `${label}滑动条`,
        exact: true,
      });
      const apply = row.getByRole("button", { name: "应用", exact: true });
      await expect(input).toHaveAttribute("aria-valuemin", String(min));
      await expect(input).toHaveAttribute("aria-valuemax", String(max));
      await expect(slider).toHaveAttribute("min", String(min));
      await expect(slider).toHaveAttribute("max", String(max));
      await expect(slider).toHaveAttribute("step", String(step));
      await expect(row.locator(".load-input-unit")).toHaveText(unit);
      await slider.focus();
      await slider.press("Home");
      await expect(input).toHaveValue(min.toFixed(digits));
      await slider.press("ArrowRight");
      await expect(input).toHaveValue((min + step).toFixed(digits));
      await input.fill(String(min));
      await input.press("ArrowUp");
      await expect(input).toHaveValue((min + step).toFixed(digits));
      const before = await page.evaluate(
        () => (window as any).loadCalls.length,
      );
      for (const invalid of [
        min - step,
        max + step,
        min + 10 ** -(digits + 1),
      ]) {
        await input.fill(String(invalid));
        await apply.click();
        await expect(
          row.locator(".fui-Field__validationMessage"),
        ).toBeVisible();
      }
      expect(await page.evaluate(() => (window as any).loadCalls.length)).toBe(
        before,
      );
      await slider.focus();
      await slider.press("End");
      await expect(input).toHaveValue(max.toFixed(digits));
      await apply.click();
      await expect(apply).toBeEnabled();
      expect(
        await page.evaluate(() => (window as any).loadCalls.at(-1)),
      ).toEqual({ kind, value: max, expectedMode: 0 });
      expect(
        await row
          .locator(".fui-Slider__rail")
          .evaluate((el) => getComputedStyle(el, "::before").backgroundImage),
      ).toBe("none");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await mkdir("artifacts/chart-detail-settings", { recursive: true });
    await page.screenshot({
      path: `artifacts/chart-detail-settings/device-settings-${width}.png`,
      fullPage: true,
    });
  });
}

for (const [mode, label, value, up, down, fine, invalid] of [
  [0, "目标电流", "1.234", "1.300", "1.200", "1.237", "1.2371"],
  [1, "目标电压", "5.67", "5.70", "5.60", "6.78", "6.789"],
  [2, "目标电阻", "12.34", "12.40", "12.30", "0.01", "0.001"],
  [3, "目标功率", "10.1", "11.0", "10.0", "10.1", "10.11"],
] as const) {
  test(`${["CC", "CV", "CR", "CP"][mode]} controls keep manual precision and coarse integer multiples`, async ({
    page,
  }) => {
    await fixture(page, mode);
    const { input, row } = parameter(page, label);
    await expect(page.locator(".load-parameters .fui-Slider")).toHaveCount(5);
    await expect(
      page
        .locator(".load-parameters")
        .getByRole("button", { name: "应用", exact: true }),
    ).toHaveCount(5);
    await expect(input).toHaveValue(value);
    await input.press("ArrowUp");
    await expect(input).toHaveValue(up);
    await input.fill(value);
    await input.press("ArrowDown");
    await expect(input).toHaveValue(down);
    await input.fill(value);
    await row
      .getByRole("button", { name: `增加${label}`, exact: true })
      .click();
    await expect(input).toHaveValue(up);
    await input.fill(value);
    await row
      .getByRole("button", { name: `减少${label}`, exact: true })
      .click();
    await expect(input).toHaveValue(down);
    expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([]);
    const slider = row.getByRole("slider");
    const coarseStep = mode === 3 ? 1 : 0.1;
    await expect(slider).toHaveAttribute("step", String(coarseStep));
    await slider.press("Home");
    const first = Number(await input.inputValue());
    await slider.press("ArrowRight");
    expect(Number(await input.inputValue()) - first).toBeCloseTo(coarseStep, 6);
    await input.fill(invalid);
    await row.getByRole("button", { name: "应用", exact: true }).click();
    await expect(row.locator(".fui-Field__validationMessage")).toBeVisible();
    expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([]);
    await input.fill(fine);
    await row.getByRole("button", { name: "应用", exact: true }).click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(fine);
    expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([
      { kind: "target", value: Number(fine), expectedMode: mode },
    ]);
  });
}

test("dependent ranges and protections prevent invalid writes and update after readback", async ({
  page,
}) => {
  await fixture(page);
  const target = parameter(page, "目标电流");
  const protection = parameter(page, "过流保护");
  for (const [control, invalid] of [
    [target, "16.201"],
    [protection, "1.233"],
    [protection, "20.001"],
    [parameter(page, "过功率保护"), "400.1"],
    [parameter(page, "截止电压"), "100.01"],
  ] as const) {
    await control.input.fill(invalid);
    await control.row
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(
      control.row.locator(".fui-Field__validationMessage"),
    ).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([]);
  await protection.input.fill("12.123");
  await protection.row
    .getByRole("button", { name: "应用", exact: true })
    .click();
  await expect(target.input).toHaveAttribute("aria-valuemax", "12.123");
  const slider = target.row.getByRole("slider");
  await slider.press("End");
  await expect(target.input).toHaveValue("12.100");
  await expect(slider).toHaveAttribute("max", "12.1");
  await target.input.fill("12.123");
  await expect(
    target.row.getByRole("button", { name: "增加目标电流" }),
  ).toBeDisabled();
});

test("CV cutoff and target stay ordered and CR coarse controls do not reach off-grid endpoints", async ({
  page,
}) => {
  await fixture(page, 1);
  const target = parameter(page, "目标电压"),
    cutoff = parameter(page, "截止电压");
  for (const [control, text] of [
    [target, "2.54"],
    [target, "100.01"],
    [cutoff, "5.68"],
  ] as const) {
    await control.input.fill(text);
    await control.row
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(
      control.row.locator(".fui-Field__validationMessage"),
    ).toBeVisible();
  }
  await target.row.getByRole("slider").press("Home");
  await expect(target.input).toHaveValue("2.60");
  await page.evaluate(() => {
    Object.assign((window as any).loadSettings, { mode: 2, target: 0.01 });
  });
  const resistance = parameter(page, "目标电阻");
  await expect(resistance.input).toHaveValue("0.01");
  await expect(
    resistance.row.getByRole("button", { name: "减少目标电阻" }),
  ).toBeDisabled();
  await resistance.row.getByRole("slider").press("Home");
  await expect(resistance.input).toHaveValue("0.10");
  await resistance.row.getByRole("slider").press("End");
  await expect(resistance.input).toHaveValue("9999.90");
  await resistance.input.fill("9999.99");
  await resistance.input.press("End");
  await expect(resistance.input).toHaveValue("9999.90");
  expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([]);
});

test("one duration slider and apply button validate both fields and keep intermediate duration positive", async ({
  page,
}) => {
  await fixture(page);
  const { input: hours, row } = parameter(page, "运行时限 / 小时");
  const minutes = row.getByRole("spinbutton", {
    name: "运行时限 / 分钟",
    exact: true,
  });
  const apply = row.getByRole("button", { name: "应用", exact: true });
  await expect(row.getByRole("slider")).toHaveCount(1);
  for (const [h, m] of [
    ["0", "0"],
    ["100", "0"],
    ["0", "60"],
    ["1.5", "1"],
    ["0", "1.5"],
  ]) {
    await hours.fill(h);
    await minutes.fill(m);
    await apply.click();
    await expect(row.locator(".fui-Field__validationMessage")).toBeVisible();
  }
  expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([]);
  await hours.fill("0");
  await minutes.fill("1");
  await apply.click();
  await expect(apply).toBeEnabled();
  await expect(hours).toHaveValue("0");
  await expect(minutes).toHaveValue("1");
  expect(await page.evaluate(() => (window as any).loadCalls)).toEqual([
    { kind: "limitMinutes", value: 1, expectedMode: 0 },
    { kind: "limitHours", value: 0, expectedMode: 0 },
  ]);
  await hours.fill("1");
  await minutes.fill("0");
  await apply.click();
  await expect(apply).toBeEnabled();
  expect(
    (await page.evaluate(() => (window as any).loadCalls)).slice(2),
  ).toEqual([
    { kind: "limitHours", value: 1, expectedMode: 0 },
    { kind: "limitMinutes", value: 0, expectedMode: 0 },
  ]);
  await row.getByRole("slider").press("End");
  await expect(hours).toHaveValue("99");
  await expect(minutes).toHaveValue("59");
  await row.getByRole("slider").press("Home");
  await expect(hours).toHaveValue("0");
  await expect(minutes).toHaveValue("1");
});

test("failed duration write stops the sequence and reports the actual device fields", async ({
  page,
}) => {
  await fixture(page);
  const { input: hours, row } = parameter(page, "运行时限 / 小时");
  const minutes = row.getByRole("spinbutton", {
    name: "运行时限 / 分钟",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).failLoadKind = "limitHours";
  });
  await hours.fill("0");
  await minutes.fill("1");
  await row.getByRole("button", { name: "应用", exact: true }).click();
  await expect(row).toContainText("设备未确认此项设置");
  await expect(hours).toHaveValue("2");
  await expect(minutes).toHaveValue("1");
  expect(
    await page.evaluate(() => (window as any).loadSettings.limitHours),
  ).toBe(2);
  expect(await page.evaluate(() => (window as any).loadCalls)).toHaveLength(2);
});

for (const width of [390, 768, 901, 1024, 1440])
  for (const dark of [false, true]) {
    test(`load inputs, sliders and actions fit ${dark ? "dark" : "light"} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 960 });
      await fixture(page, 0, dark);
      const card = page.locator(".control-card");
      const cardBox = (await card.boundingBox())!;
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      for (const row of await card.locator(".load-parameter").all()) {
        const box = (await row.boundingBox())!;
        for (const control of await row
          .locator(".fui-SpinButton, .fui-Slider, .fui-Button")
          .all()) {
          const child = (await control.boundingBox())!;
          expect(child.x).toBeGreaterThanOrEqual(box.x - 1);
          expect(child.x + child.width).toBeLessThanOrEqual(
            box.x + box.width + 1,
          );
          expect(child.x + child.width).toBeLessThanOrEqual(
            cardBox.x + cardBox.width - 11,
          );
        }
        const slider = (await row.locator(".fui-Slider").boundingBox())!;
        const firstInput = (await row
          .locator(".fui-SpinButton")
          .first()
          .boundingBox())!;
        if (await row.evaluate((el) => el.clientWidth > 380))
          expect(slider.x + slider.width).toBeLessThanOrEqual(firstInput.x);
        else expect(slider.y + slider.height).toBeLessThanOrEqual(firstInput.y);
        expect(
          await row
            .locator(".fui-Slider__rail")
            .evaluate((el) => getComputedStyle(el, "::before").backgroundImage),
        ).toBe("none");
        for (const spin of await row.locator(".fui-SpinButton").all()) {
          const bounds = (await spin.boundingBox())!;
          const unit = (await spin.locator(".load-input-unit").boundingBox())!;
          const buttons = (await spin
            .locator(".fui-SpinButton__incrementButton")
            .boundingBox())!;
          expect(unit.x).toBeGreaterThanOrEqual(bounds.x);
          expect(unit.x + unit.width).toBeLessThanOrEqual(buttons.x);
          expect(unit.y).toBeGreaterThanOrEqual(bounds.y);
          expect(unit.y + unit.height).toBeLessThanOrEqual(
            bounds.y + bounds.height,
          );
        }
      }
      await mkdir("artifacts/load-controls", { recursive: true });
      await card.screenshot({
        path: `artifacts/load-controls/${dark ? "dark" : "light"}-${width}.png`,
      });
      await page.getByRole("button", { name: "设备设置", exact: true }).click();
      for (const settingsCard of await page
        .locator(".settings-grid > .fui-Card")
        .all()) {
        const bounds = (await settingsCard.boundingBox())!;
        for (const control of await settingsCard
          .locator(
            ".load-parameter .fui-SpinButton, .load-parameter .fui-Slider, .load-parameter .fui-Button",
          )
          .all()) {
          const child = (await control.boundingBox())!;
          expect(child.x).toBeGreaterThanOrEqual(bounds.x + 11);
          expect(child.x + child.width).toBeLessThanOrEqual(
            bounds.x + bounds.width - 11,
          );
        }
      }
    });
  }
