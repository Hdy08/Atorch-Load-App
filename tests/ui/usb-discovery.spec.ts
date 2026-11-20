import { expect, test } from "@playwright/test";

const bw150 = {
  path: "/dev/bus/usb/001/002",
  name: "ATORCH BW150",
  serial: "",
  vendorId: 0x0483,
  productId: 0x5750,
  supported: true,
  permission: false,
};
const cases = [
  {
    name: "no USB link",
    diagnostics: { hostSupported: true, devices: [] },
    devices: [],
    expected: "Android 尚未识别到 USB 外设",
    detail: "系统已识别 0 个 USB 外设",
  },
  {
    name: "no USB Host support",
    diagnostics: { hostSupported: false, devices: [] },
    devices: [],
    expected: "此设备不支持 USB Host",
    detail: "请使用支持 USB Host / OTG 的 Android 设备。",
  },
  {
    name: "another USB peripheral",
    diagnostics: {
      hostSupported: true,
      devices: [
        { ...bw150, name: "USB Hub", vendorId: 0x1234, supported: false },
      ],
    },
    devices: [],
    expected: "未发现 ATORCH USB 设备",
    detail: "USB Hub · 1234:5750",
  },
  {
    name: "BW150 before USB permission",
    diagnostics: { hostSupported: true, devices: [bw150] },
    devices: [bw150],
    expected: "ATORCH BW150",
    detail: "序列号 连接后读取 · 0483:5750",
  },
];

for (const scenario of cases) {
  test(`USB discovery distinguishes ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 900 });
    await page.addInitScript(({ devices, diagnostics }) => {
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            if (command === "set_window_theme") return false;
            if (command === "discover_devices") return devices;
            if (command === "get_usb_diagnostics") return diagnostics;
            if (command === "get_snapshot")
              return {
                connected: false,
                device: null,
                telemetry: null,
                settings: null,
                sampleCount: 0,
                connectedAt: 0,
                lastReportAt: 0,
                recording: null,
                error: null,
                logs: [],
              };
            throw new Error(`Unexpected UI test command: ${command}`);
          },
        },
      });
    }, scenario);
    await page.goto("/");
    await page.getByRole("button", { name: "连接设备", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(scenario.expected, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(scenario.detail, { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(393);
    if (scenario.devices.length)
      await expect(
        dialog.getByRole("button", { name: "连接", exact: true }),
      ).toBeEnabled();
  });
}

test("scan errors appear as floating notifications while the dialog stays usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "discover_devices")
            throw new Error("USB service unavailable");
          if (command === "get_usb_diagnostics") return null;
          if (command === "get_snapshot")
            return {
              connected: false,
              device: null,
              telemetry: null,
              settings: null,
              sampleCount: 0,
              connectedAt: 0,
              lastReportAt: 0,
              recording: null,
              error: null,
              logs: [],
            };
          throw new Error(`Unexpected UI test command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("扫描失败", { exact: true })).toBeVisible();
  await expect(
    page
      .locator(".fui-Toast")
      .getByText("Error: USB service unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Error: USB service unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "重新扫描" })).toBeEnabled();
});
