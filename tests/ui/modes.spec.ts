import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(
  page: Page,
  options: { running?: boolean; bluetooth?: boolean; fail?: boolean } = {},
) {
  await page.addInitScript(
    ({ running = false, bluetooth = false, fail = false }) => {
      const settings = {
        mode: 0,
        target: 1,
        cutoffVoltage: 1,
        fullVoltage: 4.2,
        cutoffCurrent: 0.05,
        overCurrent: 16,
        overPower: 400,
        brightness: 9,
        standbyBrightness: 4,
        standbySeconds: 60,
        limitHours: 2,
        limitMinutes: 0,
      };
      const calls: any[] = [];
      Object.assign(window, {
        isTauri: true,
        modeCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "fixture",
                  name: "BW150",
                  transport: bluetooth ? "bluetooth" : "usb",
                },
                settings: bluetooth ? null : { ...settings },
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
                connectedAt: Date.now(),
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
  if (!options.bluetooth)
    await page
      .getByRole("button", { name: "切换测试模式", exact: true })
      .click();
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
    page.getByRole("dialog", { name: "切换测试模式", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("spinbutton", { name: "目标电压", exact: true }),
  ).toHaveValue("5");
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
    await page
      .getByRole("button", { name: "切换测试模式", exact: true })
      .click();
    await page
      .getByRole("button", { name: `切换到 ${code}`, exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "切换测试模式", exact: true }),
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

test("failed mode selection retains the actual mode and can be retried", async ({
  page,
}) => {
  await fixture(page, { fail: true });
  await page.getByRole("button", { name: "切换到 CV", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(/未收到设备确认/),
  ).toBeVisible();
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
  await expect(page.getByText(/普通电流目标值不适用/)).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "蓝牙面板遥控", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "测试模式", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "切换测试模式", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).modeCalls)).toEqual([]);
});

test("mode switching stays inside the load card and opens a scrollable responsive dialog without writing on cancel", async ({
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
    const card = page.locator(".mode-display");
    const trigger = card.getByRole("button", {
      name: "切换测试模式",
      exact: true,
    });
    await expect(trigger).toHaveText("切换");
    const cardBox = (await card.boundingBox())!;
    const buttonBox = (await trigger.boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width,
    );
    expect(buttonBox.x).toBeGreaterThan(cardBox.x + cardBox.width / 2);
    await mkdir("artifacts/parameter-fix", { recursive: true });
    await card.screenshot({
      path: `artifacts/parameter-fix/load-mode-${width}.png`,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "切换测试模式",
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
      path: `artifacts/parameter-fix/mode-dialog-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => (window as any).modeCalls)).toEqual([]);
  }
});
