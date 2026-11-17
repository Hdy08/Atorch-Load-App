import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  options: { denied?: boolean; recovery?: boolean; supported?: boolean } = {},
) {
  await page.setViewportSize({ width: 393, height: 900 });
  await page.addInitScript((options) => {
    const calls: boolean[] = [];
    const root = {
      supported: options.supported ?? true,
      enabled: false,
      restorePending: options.recovery ?? false,
      error: null as string | null,
    };
    const device = {
      path: "root-ui-fixture",
      name: "BW150 Root UI fixture",
      serial: "fixture",
      vendorId: 0x0483,
      productId: 0x5750,
    };
    Object.assign(window, {
      isTauri: true,
      rootUsbCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { enabled?: boolean }) => {
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
          if (command === "discover_devices")
            return root.enabled ? [device] : [];
          if (command === "get_usb_diagnostics")
            return {
              hostSupported: options.supported ?? true,
              devices: root.enabled
                ? [{ ...device, supported: true, permission: false }]
                : [],
              rootUsb: { ...root },
            };
          if (command === "set_root_usb_host") {
            calls.push(!!args?.enabled);
            if (options.denied && args?.enabled) {
              root.error = "Root 授权被拒绝，请检查 Root 管理器";
              throw new Error(root.error);
            }
            root.enabled = !!args?.enabled;
            root.restorePending = false;
            root.error = null;
            return { ...root };
          }
          throw new Error(`Unexpected Root UI test command: ${command}`);
        },
      },
    });
  }, options);
  await page.goto("/");
  await page.getByRole("button", { name: "连接设备", exact: true }).click();
  await expect(
    page.getByRole("switch", { name: "Root USB-C 直连", exact: true }),
  ).toBeVisible();
}
const calls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { rootUsbCalls: boolean[] }).rootUsbCalls,
  );

test("Root is opt-in and closing an unconnected dialog restores the role", async ({
  page,
}) => {
  await fixture(page);
  const toggle = page.getByRole("switch", {
    name: "Root USB-C 直连",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  expect(await calls(page)).toEqual([]);
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByText("BW150 Root UI fixture", { exact: true }),
  ).toBeVisible();
  expect(await calls(page)).toEqual([true]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(393);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await calls(page)).toEqual([true, false]);
});

test("denied Root leaves the switch off and shows a floating failure", async ({
  page,
}) => {
  await fixture(page, { denied: true });
  const toggle = page.getByRole("switch", {
    name: "Root USB-C 直连",
    exact: true,
  });
  await toggle.click();
  await expect(
    page
      .locator(".fui-Toast")
      .getByText("Error: Root 授权被拒绝，请检查 Root 管理器", { exact: true }),
  ).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "重新扫描", exact: true }),
  ).toBeEnabled();
});

test("a recovery record is shown without automatically requesting Root", async ({
  page,
}) => {
  await fixture(page, { recovery: true });
  const toggle = page.getByRole("switch", {
    name: "Root USB-C 直连",
    exact: true,
  });
  await expect(toggle).toBeDisabled();
  expect(await calls(page)).toEqual([]);
  await page
    .getByRole("button", { name: "恢复 USB 角色", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "恢复 USB 角色", exact: true }),
  ).toBeHidden();
  await expect(toggle).toBeEnabled();
  expect(await calls(page)).toEqual([false]);
});

test("devices without USB Host show a disabled Root option", async ({
  page,
}) => {
  await fixture(page, { supported: false });
  await expect(
    page.getByRole("switch", { name: "Root USB-C 直连", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("此设备不支持 USB Host，无法使用 Root 直连。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await calls(page)).toEqual([]);
});
