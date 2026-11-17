import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const artifacts =
  process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/workspace-layout-20261117/ui";
async function fixture(page: Page, bluetooth = false) {
  await page.addInitScript(
    ({ bluetooth }) => {
      localStorage.setItem("atorch-theme", "dark");
      const telemetry = {
        timestamp: Date.now(),
        voltage: 12,
        current: 0.3,
        power: 3.6,
        energy: 0.002,
        resistance: 40,
        capacity: 20,
        running: false,
        status: 0,
      };
      const state = {
        connected: true,
        transport: bluetooth ? "bluetooth" : "usb",
        error: null as string | null,
        calls: [] as any[],
      };
      Object.assign(window, {
        isTauri: true,
        layoutFixture: state,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            state.calls.push({ command, args });
            if (command === "set_window_theme") return true;
            if (command === "window_action") return false;
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "layout",
                  name: "ATORCH BW150 V1.1.0",
                  transport: state.transport,
                },
                telemetry,
                settings: null,
                connectedAt: 1,
                lastReportAt: telemetry.timestamp,
                sampleCount: 1,
                recording: null,
                error: null,
                recordingError: state.error,
                logs: [],
              };
            if (command === "get_history") return [telemetry];
            if (command === "list_recordings" || command === "discover_devices")
              return [];
            if (command === "get_usb_diagnostics") return null;
            if (command === "send_ble_command")
              return {
                message: "按键已发送",
                action: args.action,
                deviceConfirmed: false,
                sentAt: Date.now(),
              };
            throw Error(`Unexpected layout test command: ${command}`);
          },
        },
      });
    },
    { bluetooth },
  );
  await page.goto("/");
  await expect(page.locator(".window-titlebar")).toBeVisible();
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
  await expect(page.locator(".series-label")).toHaveText([
    "电压",
    "电流",
    "功率",
    "电阻",
    "电量",
    "容量",
    "CPU 温度",
    "MOS 温度",
    "NTC 温度",
    "风扇转速",
  ]);
}

async function settle(page: Page) {
  await page.locator("main").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

for (const width of [393, 768, 1440, 2000]) {
  test(`page titles, content starts and floating right edges share their layout (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    await fixture(page);
    const headingPositions: number[] = [];
    const cardStarts: number[] = [];
    const cardRights: number[] = [];
    for (const name of ["实时监控", "数据记录", "设备设置", "应用设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await settle(page);
      const heading = (await page
        .getByRole("heading", { name, exact: true })
        .boundingBox())!;
      headingPositions.push(heading.y);
      const spacing = await page.locator("main").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          top: parseFloat(style.paddingTop),
          left: parseFloat(style.paddingLeft),
          gap: parseFloat(style.rowGap),
        };
      });
      expect(spacing).toEqual({
        top: 24,
        left: 24,
        gap: 16,
      });
      if (name === "实时监控") {
        await expect(page.locator(".metrics").first()).toHaveCSS("gap", "12px");
      }
      if (name === "设备设置") {
        await expect(page.locator(".settings-grid")).toHaveCSS("gap", "16px");
      }
      const card = (await page
        .locator(
          name === "实时监控"
            ? ".metrics"
            : name === "设备设置"
              ? ".settings-grid"
              : name === "应用设置"
                ? ".appearance-settings"
                : "main .fui-Card",
        )
        .first()
        .boundingBox())!;
      cardRights.push(card.x + card.width);
      if (name !== "实时监控") cardStarts.push(card.y);
      expect(
        await page
          .locator(".sidebar")
          .evaluate((element) => getComputedStyle(element).borderRightWidth),
      ).toBe("0px");
    }
    expect(
      Math.max(...headingPositions) - Math.min(...headingPositions),
    ).toBeLessThan(1);
    expect(Math.max(...cardStarts) - Math.min(...cardStarts)).toBeLessThan(1);
    expect(Math.max(...cardRights) - Math.min(...cardRights)).toBeLessThan(1);
    if (width <= 1440) expect(width - cardRights[0]).toBeCloseTo(24, 0);
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await settle(page);
    const dock = (await page.locator(".floating-load-control").boundingBox())!;
    expect(dock.x + dock.width).toBeCloseTo(cardRights[0], 0);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/live-${width}.png` });
    await page.evaluate(() => {
      (window as any).layoutFixture.error =
        "通知的最大宽度应使用页面卡片的内容区域。".repeat(40);
    });
    const toast = page.locator(".fui-Toast");
    await expect(toast).toBeVisible();
    await toast.evaluate(async (element) => {
      await Promise.all(
        element
          .parentElement!.getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const notice = (await toast.boundingBox())!;
    expect(notice.x + notice.width).toBeCloseTo(cardRights[0], 0);
    const first = (await page.locator("main .fui-Card").first().boundingBox())!;
    expect(notice.width).toBeLessThanOrEqual(cardRights[0] - first.x + 1);
    expect(notice.y).toBeGreaterThanOrEqual(dock.y + dock.height);
    expect(notice.y - dock.y - dock.height).toBeCloseTo(16, 0);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/layout-${width}.png` });
  });
}

for (const width of [393, 1440]) {
  test(`controller pointer capture stays inside the page and resets on restart (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    const dock = page.locator(".floating-load-control");
    const original = (await dock.boundingBox())!;
    const handle = page.getByRole("button", { name: "拖动负载控制器" });
    await expect(handle).toHaveCSS("touch-action", "none");
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(-100, -100, { steps: 12 });
    await page.mouse.up();
    const moved = (await dock.boundingBox())!;
    expect(moved.x).toBeCloseTo(width <= 650 ? 0 : 228, 0);
    expect(moved.y).toBeCloseTo(32, 0);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await settle(page);
    expect((await dock.boundingBox())!.x).toBeCloseTo(moved.x, 0);
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(width + 100, 1100, { steps: 12 });
    await page.mouse.up();
    const bottom = (await dock.boundingBox())!;
    const navigation = (await page.locator(".sidebar").boundingBox())!;
    expect(bottom.x + bottom.width).toBeLessThanOrEqual(width);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(
      width <= 650 ? navigation.y + 1 : 901,
    );
    await page.reload();
    await expect(dock).toBeVisible();
    await expect
      .poll(async () => (await dock.boundingBox())!.x)
      .toBeCloseTo(original.x, 0);
    expect((await dock.boundingBox())!.y).toBeCloseTo(original.y, 0);
  });
}

test("BLE controller contains the four keys and opens only the Bluetooth tab", async ({
  page,
}) => {
  await fixture(page, true);
  const dock = page.locator(".floating-load-control");
  await expect(dock.locator(".ble-keys .fui-Button")).toHaveCount(4);
  await expect(dock.locator(".ble-keys .fui-Button")).toHaveText([
    "SET",
    "-",
    "+",
    "OK",
  ]);
  await mkdir(artifacts, { recursive: true });
  await dock.screenshot({ path: `${artifacts}/ble-controller.png` });
  await expect(dock.locator("button").last()).toHaveAccessibleName(
    "蓝牙控制设置",
  );
  await expect(page.locator("main .ble-controls")).toHaveCount(0);
  await expect(
    page.locator('[data-measurement="resistance"] .metric-number'),
  ).toHaveText("40.000");
  await expect(
    page.locator('[data-measurement="energy"] .metric-number'),
  ).toHaveText("0.002");
  await dock.getByRole("button", { name: "SET", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).layoutFixture.calls
        .filter((call: any) => call.command === "send_ble_command")
        .map((call: any) => call.args.action),
    ),
  ).toEqual(["keySet"]);
  await dock.getByRole("button", { name: "蓝牙控制设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab")).toHaveCount(1);
  await expect(
    dialog.getByRole("tab", { name: "蓝牙控制", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".ble-clear-actions button")).toHaveText([
    "清空电量",
    "清空容量",
    "清空计时",
  ]);
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/ble-controls.png` });
});

test("native page animations offer remembered choices and respect reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  const select = page.getByRole("combobox", { name: "页面过渡动画" });
  await expect(select).toHaveValue("slide");
  await settle(page);
  for (const choice of ["fade", "scale", "none"]) {
    await select.selectOption(choice);
    await page.getByRole("button", { name: "应用更改", exact: true }).click();
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    const frames = await page
      .locator("main")
      .evaluate((element) =>
        element
          .getAnimations()
          .map((animation) =>
            (animation.effect as KeyframeEffect).getKeyframes(),
          ),
      );
    expect(frames.length).toBe(choice === "none" ? 0 : 1);
    await page.getByRole("button", { name: "应用设置", exact: true }).click();
    await settle(page);
    await expect(select).toHaveValue(choice);
  }
  await page.reload();
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await expect(select).toHaveValue("none");
  await select.selectOption("slide");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  expect(
    await page
      .locator("main")
      .evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

test.describe("mobile page gestures", () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 850 },
  });
  test("two-finger page zoom is disabled while one-finger scrolling remains available", async ({
    page,
  }) => {
    await fixture(page);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /user-scalable=no/,
    );
    await expect(page.locator(".main-shell")).toHaveCSS(
      "touch-action",
      "pan-x pan-y",
    );
    const scale = await page.evaluate(() => visualViewport!.scale);
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 100, y: 180 },
        { x: 200, y: 280 },
      ],
    });
    for (let i = 1; i <= 6; i++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: 100 - i * 8, y: 180 - i * 8 },
          { x: 200 + i * 8, y: 280 + i * 8 },
        ],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(scale);
    const shell = page.locator(".main-shell");
    await shell.evaluate((element) => {
      element.scrollTop = 0;
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 8, y: 600 }],
    });
    for (let i = 1; i <= 8; i++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 8, y: 600 - i * 35 }],
      });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => shell.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await session.detach();
  });
});
