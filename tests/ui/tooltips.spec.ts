import { expect, test } from "@playwright/test";

for (const dark of [false, true]) {
  test(`dialog portals preserve layout during live updates (${dark ? "dark" : "light"})`, async ({
    page,
  }) => {
    // Explicit IPC fixture: it creates fresh snapshots every poll to exercise
    // the same React rerenders as live data. No hardware or USB commands run.
    await page.addInitScript(
      ({ dark }) => {
        localStorage.setItem("atorch-theme", dark ? "dark" : "light");
        let tick = 0;
        const telemetry = () => ({
          timestamp: Date.now(),
          voltage: 0,
          current: 0,
          power: 0,
          energy: 129.664,
          capacity: 6599.362,
          resistance: 0,
          cpuTemperature: 31,
          ntcTemperature: 20.5,
          mosTemperature: 26,
          fanSpeed: 0,
          running: false,
          status: 0,
        });
        Object.assign(window, {
          isTauri: true,
          __TAURI_INTERNALS__: {
            invoke: async (command: string) => {
              if (command === "get_snapshot")
                return {
                  connected: true,
                  device: {
                    path: "test-fixture",
                    name: "BW150 UI test fixture",
                    serial: "fixture",
                    vendorId: 0x0483,
                    productId: 0x5750,
                  },
                  telemetry: telemetry(),
                  settings: null,
                  sampleCount: ++tick,
                  connectedAt: Date.now() - 10000,
                  lastReportAt: Date.now(),
                  recording: null,
                  error: null,
                  logs: [],
                };
              if (command === "get_history") return [telemetry()];
              if (command === "discover_devices") return [];
              if (command === "get_usb_diagnostics") return null;
              throw new Error(`Unexpected UI test command: ${command}`);
            },
          },
        });
      },
      { dark },
    );
    await page.goto("/");
    await expect(
      page
        .locator(".sidebar-device")
        .getByRole("button", { name: "管理设备", exact: true }),
    ).toBeVisible();
    const before = await page.locator(".app").boundingBox();
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.getByRole("button", { name: "管理设备", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "连接设备" });
      await expect(dialog).toBeVisible();
      for (let i = 0; i < 6; i++) {
        const portal = await dialog.evaluate((el) => {
          const root = el.closest("[data-portal-node]")!;
          return {
            hasLayout: root.classList.contains("app"),
            height: root.getBoundingClientRect().height,
            minHeight: getComputedStyle(root).minHeight,
          };
        });
        expect(portal).toEqual({
          hasLayout: false,
          height: 0,
          minHeight: "0px",
        });
        expect(await page.locator(".app").boundingBox()).toEqual(before);
        await page.waitForTimeout(250);
      }
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toBeHidden();
    }
  });
}

test("all pages fit mobile, tablet and desktop widths", async ({ page }) => {
  await page.goto("/");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const label of ["实时监控", "数据记录", "设备设置", "应用设置"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${width}: ${label}`,
      ).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await page.getByRole("tab", { name: "固件更新", exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `${width}: 设备设置 / 固件更新`,
    ).toBeLessThanOrEqual(width);
  }
});
