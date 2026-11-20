import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(
  page: Page,
  options: {
    running?: boolean;
    bluetooth?: boolean;
    fail?: boolean;
    name?: string;
    cycleCount?: number;
    loadLimits?: { voltage: number; current: number; power: number };
  } = {},
) {
  await page.addInitScript(
    ({
      running = false,
      bluetooth = false,
      fail = false,
      name = "BW150",
      cycleCount,
      loadLimits,
    }) => {
      const settings = {
        mode: 0,
        target: 1,
        cutoffVoltage: 1,
        fullVoltage: 4.2,
        cutoffCurrent: 0.05,
        overCurrent: loadLimits ? 30 : 16,
        overPower: loadLimits ? 600 : 400,
        cycleCount,
        brightness: 9,
        standbyBrightness: 4,
        standbySeconds: 60,
        limitHours: 2,
        limitMinutes: 0,
      };
      const calls: any[] = [];
      const connectedAt = Date.now();
      Object.assign(window, {
        isTauri: true,
        modeCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "set_window_theme") return false;
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "fixture",
                  name,
                  transport: bluetooth ? "bluetooth" : "usb",
                },
                settings: bluetooth ? null : { ...settings },
                loadLimits,
                telemetry: {
                  timestamp: Date.now(),
                  voltage: 0,
                  current: 0,
                  power: 0,
                  capacity: 6620,
                  energy: null,
                  resistance: null,
                  running: bluetooth ? null : running,
                },
                sampleCount: 1,
                connectedAt,
                lastReportAt: Date.now(),
                recording: null,
                logs: [],
                error: null,
              };
            if (command === "get_history") return [];
            if (command === "send_command") {
              calls.push(args.command);
              await new Promise((resolve) => setTimeout(resolve, 350));
              if (fail)
                throw new Error("未收到设备确认，请读取设备状态后再操作");
              if (args.command.kind === "mode") {
                settings.mode = args.command.value;
                settings.target = settings.mode ? 5 : 1;
              }
              if (args.command.kind === "cycleCount")
                settings.cycleCount = args.command.value;
              return;
            }
            throw Error(`Unexpected mode command: ${command}`);
          },
        },
      });
    },
    options,
  );
  await page.goto("/");
  if (!options.bluetooth) await openModes(page);
}

async function openModes(page: Page) {
  await page.getByRole("button", { name: "负载控制设置", exact: true }).click();
  await page.getByRole("tab", { name: "模式切换", exact: true }).click();
}

test("mode changes wait for confirmation, refresh target units and never start the load", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator('[data-mode="CC"]')).toHaveClass(/active/);
  await page.getByRole("button", { name: "切换到 CV", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "切换到 CR", exact: true }),
  ).toBeDisabled();
  await expect(page.locator('[data-mode="CC"]')).toHaveClass(/active/);
  await expect(
    page.getByRole("dialog", { name: "负载控制", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("spinbutton", { name: "目标电压快速设定", exact: true }),
  ).toHaveValue("5.00");
  await expect(page.locator(".mode-code")).toHaveText("CV");
  await page.getByRole("button", { name: "启动负载", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("恒压模式");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  for (const code of [
    "CR",
    "CP",
    "IR",
    "POWER",
    "CABLE",
    "CDC",
    "CDCDC",
    "CDxn",
    "CC",
  ]) {
    await openModes(page);
    await page
      .getByRole("button", { name: `切换到 ${code}`, exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "负载控制", exact: true }),
    ).toBeHidden();
    await expect(page.locator(".mode-code")).toHaveText(code);
  }
  const calls = await page.evaluate(() => (window as any).modeCalls);
  expect(calls.map((c: any) => c.kind)).toEqual(Array(10).fill("mode"));
  expect(calls.map((c: any) => c.expectedMode)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("mode cards contain only code and title, expose descriptions on hover, and activate by click or keyboard", async ({
  page,
}, info) => {
  await fixture(page);
  await expect(page.getByText(/当前模式：/)).toHaveCount(0);
  await expect(
    page.locator(".test-mode button, .test-mode-footer, .test-mode p"),
  ).toHaveCount(0);
  const cv = page.locator('[data-mode="CV"]');
  await expect(cv).toHaveText("CV恒压模式");
  await cv.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "保持设定电压，测试电源限流特性",
  );
  await page.screenshot({ path: info.outputPath("compact-mode-cards.png") });
  await cv.getByRole("heading").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.evaluate(() => (window as any).modeCalls)).toHaveLength(1);
  await openModes(page);
  await expect(page.locator('[data-mode="CV"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const cr = page.locator('[data-mode="CR"]');
  await cr.focus();
  await cr.press("Space");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(
    await page.evaluate(() =>
      (window as any).modeCalls.map((call: any) => call.value),
    ),
  ).toEqual([1, 2]);
});

test("DL24 exposes only its four load modes and excludes charging settings", async ({
  page,
}) => {
  await fixture(page, { name: "ATORCH DL24 V1.1.0" });
  await expect(page.locator(".test-mode")).toHaveCount(4);
  await page.getByRole("button", { name: "切换到 CP", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("spinbutton", { name: "目标功率快速设定", exact: true }),
  ).toHaveValue("5.0");
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByLabel("设备设置", { exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "截止电压", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("spinbutton", { name: /充电上限电压|充电截止电流/ }),
  ).toHaveCount(0);
});

test("BW600 uses its USB limits and exposes CDxn settings only when the device supplies them", async ({
  page,
}) => {
  await fixture(page, {
    name: "ATORCH BW600 V2.0.5",
    cycleCount: 10,
    loadLimits: { voltage: 200, current: 50, power: 1200 },
  });
  await page.getByRole("button", { name: "切换到 CV", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("spinbutton", { name: "目标电压快速设定", exact: true }),
  ).toHaveAttribute("aria-valuemax", "200");
  await openModes(page);
  await page.getByRole("button", { name: "切换到 CDxn", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "负载控制设置", exact: true }).click();
  const count = page.getByRole("spinbutton", { name: "循环次数", exact: true });
  await expect(count).toHaveValue("10");
  await count.fill("15");
  await page
    .locator(".load-parameter")
    .filter({ has: count })
    .getByRole("button", { name: "应用", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).modeCalls.at(-1)))
    .toMatchObject({ kind: "cycleCount", value: 15, expectedMode: 9 });
  await expect(page.getByTestId("special-test")).toContainText("15 次");
  await page
    .getByRole("dialog", { name: "负载控制" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "启动专用测试", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("15 次充放电循环");
  await page.getByRole("button", { name: "取消", exact: true }).click();
});

test("failed mode selection retains the actual mode and can be retried", async ({
  page,
}) => {
  await fixture(page, { fail: true });
  await page.getByRole("button", { name: "切换到 CV", exact: true }).click();
  await expect(
    page.locator(".fui-Toast").getByText(/未收到设备确认/),
  ).toBeVisible();
  await expect(
    page.locator(".fui-Toast").filter({ hasText: "未收到设备确认" }),
  ).toHaveCount(1);
  await expect(page.locator('[data-mode="CC"]')).toHaveClass(/active/);
  await expect(page.locator('[data-mode="CV"]')).not.toHaveClass(/active/);
  await expect(
    page.getByRole("button", { name: "切换到 CV", exact: true }),
  ).toBeEnabled();
});

test("running loads cannot select a mode", async ({ page }) => {
  await fixture(page, { running: true });
  await expect(
    page.getByRole("button", { name: "切换到 CV", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => (window as any).modeCalls)).toEqual([]);
});

test("target writes retain the mode whose unit the user edited", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "切换到 CV", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "负载控制设置", exact: true }).click();
  const parameter = page.locator(".parameter").filter({ hasText: "目标电压" });
  await parameter.getByRole("spinbutton").fill("6");
  await parameter.getByRole("button", { name: "应用", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).modeCalls))
    .toContainEqual({ kind: "target", value: 6, expectedMode: 1 });
});

test("special test entry requires confirmation and never invents a target", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "切换到 IR", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "启动专用测试", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "启动专用测试", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("IR");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "目标电流", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".floating-load-target")).toHaveCount(0);
  await page.getByRole("button", { name: "负载控制设置", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "快速设定", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  expect(
    (await page.evaluate(() => (window as any).modeCalls)).map(
      (c: any) => c.kind,
    ),
  ).toEqual(["mode"]);
});

test("BLE keeps the panel remote without exposing USB mode controls", async ({
  page,
}) => {
  await fixture(page, { bluetooth: true });
  await expect(page.locator(".ble-keys")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "测试模式", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "负载控制", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).modeCalls)).toEqual([]);
});

test("mode switching opens from the floating control in a scrollable responsive dialog without writing on cancel", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "测试模式", exact: true }),
  ).toHaveCount(0);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const card = page.locator(".floating-load-control");
    const trigger = card.getByRole("button", {
      name: "负载控制设置",
      exact: true,
    });
    await expect(trigger).toHaveText("");
    const cardBox = (await card.boundingBox())!;
    const buttonBox = (await trigger.boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width,
    );
    expect(buttonBox.x).toBeGreaterThan(cardBox.x + cardBox.width / 2);
    await mkdir("artifacts/floating-controls-20261117/ui", { recursive: true });
    await card.screenshot({
      path: `artifacts/floating-controls-20261117/ui/load-mode-${width}.png`,
    });
    await trigger.click();
    await page.getByRole("tab", { name: "模式切换", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "负载控制",
      exact: true,
    });
    await expect(dialog.locator(".test-mode")).toHaveCount(10);
    await expect(dialog).toHaveCSS("opacity", "1");
    const dialogBox = (await dialog.boundingBox())!;
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(900);
    if (width === 1440) expect(dialogBox.width).toBeGreaterThan(900);
    const content = dialog.locator(".mode-dialog-content");
    expect(await content.evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(
      await content.evaluate((el) => el.clientWidth),
    );
    await page.screenshot({
      path: `artifacts/floating-controls-20261117/ui/mode-dialog-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => (window as any).modeCalls)).toEqual([]);
  }
});
