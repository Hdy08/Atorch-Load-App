import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

for (const width of [390, 1440]) {
  test(`cutoff voltage and temperature coefficient remain distinct (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    // UI-only IPC fixture. The Rust tests separately decode the actual USB frame.
    await page.addInitScript(() => {
      const settings: Record<string, number> = {
        mode: 0,
        target: 1,
        cutoffVoltage: 2.499999523162842,
        temperatureCalibration: 1,
        voltageCalibration: 0.9919446706771851,
        currentCalibration: 0.9810318350791931,
        fullVoltage: 4.2,
        cutoffCurrent: 0.05,
        overCurrent: 16,
        overPower: 400,
        ntcLimit: 100,
        mosLimit: 100,
        brightness: 9,
        standbyBrightness: 4,
        standbySeconds: 60,
        limitHours: 2,
        limitMinutes: 0,
        language: 1,
      };
      const calls: any[] = [];
      Object.assign(window, {
        isTauri: true,
        parameterCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "get_history") return [];
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "parameter-ui-fixture",
                  name: "BW150 · 界面验证数据",
                  serial: "UI fixture",
                  vendorId: 0x0483,
                  productId: 0x5750,
                  transport: "usb",
                },
                settings: { ...settings },
                telemetry: {
                  timestamp: Date.now(),
                  voltage: 0,
                  current: 0,
                  power: 0,
                  capacity: 0,
                  energy: 0,
                  resistance: 0,
                  running: false,
                  status: 0,
                },
                sampleCount: 1,
                connectedAt: 1,
                lastReportAt: Date.now(),
                recording: null,
                logs: [],
                error: null,
              };
            if (
              command === "send_command" &&
              ["cutoffVoltage", "temperatureCalibration"].includes(
                args.command.kind,
              )
            ) {
              calls.push(args.command);
              settings[args.command.kind] = args.command.value;
              return;
            }
            throw new Error(`Unexpected parameter test command: ${command}`);
          },
        },
      });
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "负载控制设置", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "截止电压", exact: true }),
    ).toHaveValue("2.50");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    const cutoff = page.getByRole("spinbutton", {
      name: "截止电压",
      exact: true,
    });
    const temperature = page.getByRole("spinbutton", {
      name: "温度校准系数",
      exact: true,
    });
    await expect(cutoff).toHaveValue("2.50");
    await expect(temperature).toHaveValue("1.0000");
    await expect(temperature).toHaveAttribute("min", "0.5");
    await expect(temperature).toHaveAttribute("max", "2");
    await expect(page.getByText("温度补偿", { exact: true })).toHaveCount(0);
    await mkdir("artifacts/parameter-fix", { recursive: true });
    await page.screenshot({
      path: `artifacts/parameter-fix/ui-${width}.png`,
      fullPage: true,
    });
    const temperatureRow = page
      .locator(".parameter")
      .filter({ has: temperature });
    await temperature.fill("0");
    await temperatureRow
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(temperatureRow).toContainText("请输入范围内的有效数值");
    expect(await page.evaluate(() => (window as any).parameterCalls)).toEqual(
      [],
    );
    await temperature.fill("1.125");
    await temperatureRow
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("温度校准系数");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.evaluate(() => (window as any).parameterCalls)).toEqual(
      [],
    );
    await temperatureRow
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认写入设备校准", exact: true })
      .click();
    await expect(temperature).toHaveValue("1.1250");
    await expect(cutoff).toHaveValue("2.50");
    await cutoff.fill("2.75");
    await page
      .locator(".parameter")
      .filter({ has: cutoff })
      .getByRole("button", { name: "应用", exact: true })
      .click();
    await expect(cutoff).toHaveValue("2.75");
    await expect(temperature).toHaveValue("1.1250");
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await page
      .getByRole("button", { name: "负载控制设置", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "截止电压", exact: true }),
    ).toHaveValue("2.75");
    expect(await page.evaluate(() => (window as any).parameterCalls)).toEqual([
      { kind: "temperatureCalibration", value: 1.125 },
      { kind: "cutoffVoltage", value: 2.75, expectedMode: 0 },
    ]);
  });
}
