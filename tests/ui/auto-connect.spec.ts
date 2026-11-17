import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  scenario: "usb" | "ble" | "usb-failed" | "late-usb" | "cancel",
) {
  await page.addInitScript(
    ({ scenario }) => {
      const usb = {
        path: "usb-auto",
        name: "ATORCH BW150",
        serial: "auto",
        vendorId: 0x483,
        productId: 0x5750,
        transport: "usb",
      };
      const ble = {
        ...usb,
        path: "ble://auto",
        name: "BW150_BLE",
        serial: "",
        transport: "bluetooth",
        rssi: -50,
      };
      let device: typeof usb | null = null;
      let finishScan: ((devices: (typeof usb)[]) => void) | undefined;
      let bleScanned = false;
      const calls: { command: string; path?: string }[] = [];
      Object.assign(window, {
        isTauri: true,
        autoCalls: calls,
        detachAutoDevice: () => {
          device = null;
        },
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: { path: string }) => {
            if (command === "set_window_theme") return;
            calls.push({ command, path: args?.path });
            if (command === "get_snapshot")
              return {
                connected: !!device,
                device,
                telemetry: null,
                settings: null,
                sampleCount: 0,
                connectedAt: device ? 1 : 0,
                lastReportAt: 0,
                recording: null,
                error: null,
                logs: [],
              };
            if (command === "get_history") return [];
            if (command === "get_usb_diagnostics") return null;
            if (command === "discover_devices")
              return scenario === "usb" ||
                scenario === "usb-failed" ||
                (scenario === "late-usb" && bleScanned)
                ? [usb]
                : [];
            if (command === "get_bluetooth_status")
              return {
                supported: true,
                enabled: true,
                permission: true,
                locationRequired: false,
                locationEnabled: true,
              };
            if (command === "discover_bluetooth") {
              bleScanned = true;
              return scenario === "cancel"
                ? new Promise<(typeof usb)[]>((resolve) => {
                    finishScan = resolve;
                  })
                : [ble];
            }
            if (command === "stop_bluetooth_scan") {
              finishScan?.([]);
              return;
            }
            if (command === "connect_device") {
              if (scenario === "usb-failed" && args?.path === usb.path)
                throw new Error("USB unavailable");
              device = args?.path === usb.path ? usb : ble;
              return;
            }
            if (command === "disconnect_device") {
              device = null;
              return;
            }
            throw new Error(
              `Unexpected automatic connection command ${command}`,
            );
          },
        },
      });
    },
    { scenario },
  );
  await page.goto("/");
}

for (const scenario of ["usb", "ble", "usb-failed", "late-usb"] as const) {
  test(`disconnected app automatically connects with USB priority: ${scenario}`, async ({
    page,
  }) => {
    await fixture(page, scenario);
    await expect(
      page.getByRole("button", { name: "管理设备", exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    const calls = await page.evaluate(
      () => (window as any).autoCalls as { command: string; path?: string }[],
    );
    const connected = calls
      .filter((c) => c.command === "connect_device")
      .map((c) => c.path);
    expect(connected.at(-1)).toBe(
      scenario === "usb" || scenario === "late-usb" ? "usb-auto" : "ble://auto",
    );
    expect(
      calls.findIndex((c) => c.command === "discover_devices"),
    ).toBeLessThan(calls.findIndex((c) => c.command === "connect_device"));
    if (scenario === "usb")
      expect(calls.some((c) => c.command === "discover_bluetooth")).toBe(false);
    if (scenario === "usb-failed")
      expect(connected).toEqual(["usb-auto", "ble://auto"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("physical detachment starts a new automatic connection cycle", async ({
  page,
}) => {
  await fixture(page, "usb");
  await expect(
    page.getByRole("button", { name: "管理设备", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => (window as any).detachAutoDevice());
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).autoCalls.filter(
              (c: any) => c.command === "connect_device",
            ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(2);
  await expect(
    page.getByRole("button", { name: "管理设备", exact: true }),
  ).toBeVisible();
});

test("opening device management cancels automatic BLE scanning before manual discovery", async ({
  page,
}) => {
  await fixture(page, "cancel");
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as any).autoCalls.some(
            (call: any) => call.command === "discover_bluetooth",
          ),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect(page.locator(".device-connection-status")).toHaveText(
    "(未连接)",
  );
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("未发现 ATORCH 设备", { exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).autoCalls as { command: string }[],
  );
  expect(calls.filter((c) => c.command === "stop_bluetooth_scan")).toHaveLength(
    1,
  );
  expect(calls.filter((c) => c.command === "connect_device")).toHaveLength(0);
});

test("manual disconnection stays disconnected until a manual connection succeeds", async ({
  page,
}) => {
  await fixture(page, "usb");
  await page
    .getByRole("button", { name: "管理设备", exact: true })
    .click({ timeout: 10_000 });
  await page.getByRole("button", { name: "断开设备", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".device-connection-status")).toHaveText(
    "(未连接)",
  );
  const scanCount = await page.evaluate(
    () =>
      (window as any).autoCalls.filter(
        (call: any) => call.command === "discover_devices",
      ).length,
  );
  // Cross both the initial scan delay and a complete automatic retry period.
  await page.waitForTimeout(7000);
  expect(
    await page.evaluate(
      () =>
        (window as any).autoCalls.filter(
          (call: any) => call.command === "connect_device",
        ).length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as any).autoCalls.filter(
          (call: any) => call.command === "discover_devices",
        ).length,
    ),
  ).toBe(scanCount);
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "连接", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".device-connection-status")).toHaveText("(USB)");
  await page.evaluate(() => (window as any).detachAutoDevice());
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).autoCalls.filter(
              (call: any) => call.command === "connect_device",
            ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(3);
});
