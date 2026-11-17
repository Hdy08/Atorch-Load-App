import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(page: Page, { denied = false, desktop = false } = {}) {
  await page.setViewportSize({ width: desktop ? 1440 : 393, height: 900 });
  await page.addInitScript(
    ({ denied, desktop }) => {
      const device = {
        path: "ble://00:00:00:17:BB:84",
        name: "BW150_BLE",
        serial: "",
        vendorId: 0,
        productId: 0,
        transport: "bluetooth",
        rssi: -60,
      };
      let connected = false;
      let connectedAt = 0;
      const calls: string[] = [];
      Object.assign(window, {
        isTauri: true,
        bluetoothCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: { action: string }) => {
            if (command === "set_window_theme") return false;
            calls.push(command);
            if (command === "get_snapshot")
              return {
                connected,
                device: connected ? device : null,
                telemetry: connected
                  ? {
                      timestamp: Date.now(),
                      voltage: 0,
                      current: 0,
                      power: 0,
                      energy: 0,
                      capacity: 6620,
                      resistance: 0,
                      cpuTemperature: null,
                      ntcTemperature: null,
                      mosTemperature: 26,
                      fanSpeed: null,
                      running: null,
                      status: 0,
                    }
                  : null,
                settings: null,
                sampleCount: connected ? 10 : 0,
                connectedAt,
                lastReportAt: connected ? Date.now() : 0,
                recording: null,
                error: null,
                logs: [],
              };
            if (command === "discover_devices") return [];
            if (command === "get_usb_diagnostics")
              return desktop ? null : { hostSupported: true, devices: [] };
            if (command === "get_bluetooth_status")
              return {
                supported: true,
                enabled: true,
                permission: !denied,
                locationRequired: false,
                locationEnabled: true,
              };
            if (command === "discover_bluetooth") {
              if (denied)
                throw new Error(
                  "未获得蓝牙扫描权限，请在系统设置中允许附近设备访问后重试",
                );
              return [device];
            }
            if (command === "connect_device") {
              connected = true;
              connectedAt = Date.now() - 10000;
              return;
            }
            if (command === "disconnect_device") {
              connected = false;
              return;
            }
            if (command === "get_history") {
              const state = await (window as any).__TAURI_INTERNALS__.invoke(
                "get_snapshot",
              );
              return connected ? [state.telemetry] : [];
            }
            if (command === "send_ble_command") {
              calls.push(`ble:${args?.action}`);
              return {
                action: args?.action,
                sentAt: Date.now(),
                deviceConfirmed: false,
                message: "按键已发送；设备未提供执行确认，请核对 BW150 屏幕。",
              };
            }
            if (command === "stop_bluetooth_scan") return;
            throw new Error(`Unexpected BLE UI test command: ${command}`);
          },
        },
      });
    },
    { denied, desktop },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "蓝牙", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "蓝牙", exact: true }).click();
}

test("desktop can select Bluetooth, scan and connect without Android USB diagnostics", async ({
  page,
}) => {
  await fixture(page, { desktop: true });
  const dialog = page.getByRole("dialog");
  const tabs = dialog.getByRole("tablist", { name: "连接方式" });
  await expect(
    tabs.getByRole("tab", { name: "USB", exact: true }),
  ).toBeVisible();
  await expect(
    tabs.getByRole("tab", { name: "蓝牙", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("BW150_BLE", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("switch", { name: "Root USB-C 直连", exact: true }),
  ).toHaveCount(0);
  await tabs.getByRole("tab", { name: "USB", exact: true }).click();
  await expect(
    dialog.getByText("未发现 ATORCH 设备", { exact: true }),
  ).toBeVisible();
  await tabs.getByRole("tab", { name: "蓝牙", exact: true }).click();
  await expect(dialog.getByText("BW150_BLE", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".ble-keys")).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { bluetoothCalls: string[] }).bluetoothCalls,
  );
  expect(calls.filter((c) => c === "discover_bluetooth")).toHaveLength(2);
  expect(calls).not.toContain("set_root_usb_host");
  expect(calls).not.toContain("send_command");
  expect(calls).not.toContain("send_ble_command");
});

for (const desktop of [true, false]) {
  test(`connection management stays in the sidebar and dialog actions fit ${desktop ? "desktop" : "mobile"}`, async ({
    page,
  }) => {
    const width = desktop ? 1440 : 393;
    await fixture(page, { desktop });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "连接", exact: true })
      .click();
    const connection = page.getByRole("region", {
      name: "设备连接",
      exact: true,
    });
    await expect(
      connection.getByRole("button", { name: "管理设备", exact: true }),
    ).toBeVisible();
    await expect(connection.locator(".device-connection-status")).toHaveText(
      "(BLE)",
    );
    await expect(
      page
        .locator("main")
        .getByRole("button", { name: /^(连接设备|管理设备|设备已连接)$/ }),
    ).toHaveCount(0);
    await expect(page.getByText("设备已连接", { exact: true })).toHaveCount(0);
    await expect(page.locator(".connection-strip")).toHaveCount(0);
    await expect(page.getByText(/^蓝牙已连接，支持实时监测/)).toHaveCount(0);
    await connection
      .getByRole("button", { name: "管理设备", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(
        /选择已通过 USB 连接|选择附近的 BW150 蓝牙设备|扫描 BW150_BLE，约需 6 秒/,
      ),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "重新扫描", exact: true }),
    ).toBeEnabled();
    // Measure after Fluent's entrance scale animation reaches its final size.
    await expect
      .poll(
        async () =>
          (
            await dialog
              .getByRole("button", { name: "断开设备", exact: true })
              .boundingBox()
          )?.height,
      )
      .toBe(32);
    const dialogBox = (await dialog.boundingBox())!;
    const boxes = [];
    for (const label of ["断开设备", "重新扫描", "关闭"]) {
      const button = dialog.getByRole("button", { name: label, exact: true });
      await expect(button).toHaveCSS("white-space", "nowrap");
      const box = (await button.boundingBox())!;
      expect(box.height).toBe(32);
      expect(box.x).toBeGreaterThanOrEqual(dialogBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(
        dialogBox.x + dialogBox.width,
      );
      boxes.push(box);
    }
    if (desktop) {
      expect(boxes[0].y).toBe(boxes[1].y);
      expect(boxes[1].y).toBe(boxes[2].y);
      expect(boxes[0].x + boxes[0].width).toBeLessThan(boxes[1].x);
      expect(boxes[1].x + boxes[1].width).toBeLessThan(boxes[2].x);
    } else {
      expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y);
      expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[2].y);
      expect(boxes[0].width).toBe(boxes[1].width);
      expect(boxes[1].width).toBe(boxes[2].width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await mkdir("artifacts/fluent-themes", { recursive: true });
    await dialog.screenshot({
      path: `artifacts/fluent-themes/connection-${desktop ? "desktop" : "mobile"}.png`,
    });
  });
}

test("BLE discovery connects to the selected device and hides unconfirmed values", async ({
  page,
}) => {
  await fixture(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("BW150_BLE", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("00:00:00:17:BB:84 · -60 dBm", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".ble-keys")).toBeVisible();
  await expect(page.getByText("设备状态未知", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "OK", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator('.metric[data-measurement="resistance"] .metric-value'),
  ).toContainText("0.000");
  await expect(
    page.locator('.metric[data-measurement="capacity"]'),
  ).toContainText("6620");
  await expect(
    page.locator('.metric[data-measurement="energy"]'),
  ).toContainText("0.000");
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeEnabled();
  await page.getByRole("checkbox", { name: "MOS 温度", exact: true }).check();
  await expect(page.locator(".thermal-metrics")).toContainText("26.0");
  await expect(page.locator(".thermal-metrics > .metric")).toHaveCount(4);
  await expect(
    page.locator('.thermal-metrics [data-measurement="mosTemperature"]'),
  ).toContainText("26.0");
  await expect(
    page.getByRole("checkbox", { name: "设备温度 (°C)", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        return getInstanceByDom(document.querySelector(".trend-chart"))
          .getOption()
          .series.find((series: any) => series.id === "mosTemperature")
          ?.data[0]?.[1];
      }),
    )
    .toBe(26);
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  for (const name of ["电流零点校准", "清空设备累计数据", "恢复出厂设置"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  const calls = await page.evaluate(
    () => (window as unknown as { bluetoothCalls: string[] }).bluetoothCalls,
  );
  expect(calls).not.toContain("send_command");
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["实时监控", "数据记录", "设备设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
  }
});

for (const desktop of [false, true]) {
  test(`BLE remote stays in live view with four keys on one row (${desktop ? "desktop" : "mobile"})`, async ({
    page,
  }) => {
    await fixture(page, { desktop });
    await page.getByRole("button", { name: "连接", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator(".ble-controls")).toHaveCount(1);
    await expect(
      page.getByText(/这些操作写入设备。设备仅回传|按键作用与设备面板一致/),
    ).toHaveCount(0);
    for (const width of desktop ? [1440] : [330, 360, 393]) {
      await page.setViewportSize({ width, height: 960 });
      const keys = page.locator(".ble-keys > .fui-Button");
      await expect(keys).toHaveText(["SET", "-", "+", "OK"]);
      const boxes = await keys.evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return {
            y: box.y,
            x: box.x,
            width: box.width,
            height: box.height,
            content: button.scrollWidth,
            client: button.clientWidth,
          };
        }),
      );
      expect(new Set(boxes.map((box) => box.y)).size).toBe(1);
      expect(new Set(boxes.map((box) => box.height)).size).toBe(1);
      expect(
        boxes.every((box) => box.content <= box.client + 1),
        JSON.stringify(boxes),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
    await mkdir("artifacts/chart-detail-settings", { recursive: true });
    await page.locator(".floating-load-control").screenshot({
      path: `artifacts/chart-detail-settings/ble-remote-${desktop ? "desktop" : "mobile"}.png`,
    });
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await expect(page.locator(".ble-controls")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "蓝牙面板遥控", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await expect(page.locator(".ble-controls")).toHaveCount(1);
    expect(
      await page.evaluate(() =>
        (window as any).bluetoothCalls.filter((call: string) =>
          call.startsWith("ble:"),
        ),
      ),
    ).toEqual([]);
  });
}

test("BLE keys including OK send once without a dialog and clear requires acknowledging data loss", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "+", exact: true }).click();
  await expect(
    page.locator(".fui-Toast").getByText(/按键已发送；设备未提供执行确认/),
  ).toBeVisible();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { bluetoothCalls: string[] }).bluetoothCalls,
    ),
  ).toContain("ble:keyOk");
  await page.getByRole("button", { name: "蓝牙控制设置", exact: true }).click();
  await page.getByRole("button", { name: "清空容量", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "确认清零并发送", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "确认清零并发送", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const calls = await page.evaluate(
    () => (window as unknown as { bluetoothCalls: string[] }).bluetoothCalls,
  );
  expect(calls.filter((c) => c.startsWith("ble:"))).toEqual([
    "ble:keyPlus",
    "ble:keyOk",
    "ble:clearCapacity",
  ]);
  expect(calls).not.toContain("send_command");
  await expect(page.locator(".ble-keys")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "切换测试模式", exact: true }),
  ).toHaveCount(0);
});

test("denied Nearby Devices permission is explained by a floating failure", async ({
  page,
}) => {
  await fixture(page, { denied: true });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("蓝牙扫描失败", { exact: true })).toBeVisible();
  await expect(
    page.locator(".fui-Toast").getByText(/Error: 未获得蓝牙扫描权限/),
  ).toBeVisible();
  await expect(dialog.getByText(/Error: 未获得蓝牙扫描权限/)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "重新扫描" })).toBeEnabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as { bluetoothCalls: string[] }).bluetoothCalls,
    ),
  ).toContain("stop_bluetooth_scan");
});

test("closing a scan prevents its late result from replacing a newer scan", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.getByText("BW150_BLE", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (c: string, a?: unknown) => Promise<unknown>;
      };
      finishScan: Array<(value: unknown) => void>;
    };
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.finishScan = [];
    w.__TAURI_INTERNALS__.invoke = (c, a) =>
      c === "discover_bluetooth"
        ? new Promise((resolve) => w.finishScan.push(resolve))
        : invoke(c, a);
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "重新扫描" }).click();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await dialog.getByRole("button", { name: "重新扫描" }).click();
  await page.waitForFunction(
    () =>
      (window as unknown as { finishScan: unknown[] }).finishScan.length === 2,
  );
  await page.evaluate(() => {
    (
      window as unknown as { finishScan: Array<(v: unknown) => void> }
    ).finishScan[0]([
      { name: "BW150_OLD", path: "ble://old", transport: "bluetooth" },
    ]);
  });
  await expect(dialog.getByRole("button", { name: "重新扫描" })).toBeDisabled();
  await expect(dialog.getByText("BW150_OLD")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { finishScan: Array<(v: unknown) => void> }
    ).finishScan[1]([
      { name: "BW150_NEW", path: "ble://new", transport: "bluetooth" },
    ]);
  });
  await expect(dialog.getByText("BW150_NEW", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "重新扫描" })).toBeEnabled();
});
