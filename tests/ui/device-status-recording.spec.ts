import { expect, test, type Page } from "@playwright/test";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { mkdir } from "node:fs/promises";

const artifacts = "artifacts/floating-controls-20261117/ui";
const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

async function fixture(page: Page, connected = true, customTitlebar = false) {
  await page.addInitScript(
    ({ connected, customTitlebar }) => {
      const state = {
        connected,
        device: connected
          ? {
              path: "usb-ui-fixture",
              name: "ATORCH BW150 V1.1.0",
              serial: "fixture",
              vendorId: 0x483,
              productId: 0x5750,
              transport: "usb",
            }
          : null,
        error: null as string | null,
        autoRecordOnLoad:
          localStorage.getItem("fixture-auto-record") === "true",
        autoRecording: JSON.parse(
          localStorage.getItem("fixture-auto-record-settings") ?? "null",
        ),
        calls: [] as { command: string; args: any }[],
        maximized: false,
      };
      const telemetry = {
        timestamp: Date.now(),
        voltage: 12,
        current: 0.1,
        power: 1.2,
        resistance: 120,
        energy: 1,
        capacity: 100,
        cpuTemperature: 31,
        ntcTemperature: 20.5,
        mosTemperature: 26,
        fanSpeed: 1200,
        running: false,
        status: 0,
      };
      Object.assign(window, {
        isTauri: true,
        statusFixture: state,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            state.calls.push({ command, args });
            if (command === "set_window_theme") return customTitlebar;
            if (command === "window_action") {
              if (args.action === "maximize")
                state.maximized = !state.maximized;
              return state.maximized;
            }
            if (command === "get_snapshot")
              return {
                connected: state.connected,
                device: state.device,
                telemetry: state.connected ? telemetry : null,
                settings: null,
                sampleCount: state.connected ? 1 : 0,
                samplingPaused: false,
                autoRecordOnLoad: state.autoRecordOnLoad,
                autoRecording: state.autoRecording ?? undefined,
                connectedAt: telemetry.timestamp,
                lastReportAt: telemetry.timestamp,
                recording: null,
                error: state.error,
                logs: [],
              };
            if (command === "get_history")
              return state.connected ? [telemetry] : [];
            if (command === "get_usb_diagnostics") return null;
            if (command === "discover_devices") return [];
            if (command === "get_bluetooth_status") return { supported: false };
            if (command === "stop_bluetooth_scan") return;
            if (command === "set_auto_record_on_load") {
              state.autoRecordOnLoad = args.enabled;
              localStorage.setItem("fixture-auto-record", String(args.enabled));
              return;
            }
            if (command === "set_auto_recording") {
              state.autoRecording = args.settings;
              localStorage.setItem(
                "fixture-auto-record-settings",
                JSON.stringify(args.settings),
              );
              return;
            }
            throw Error(`Unexpected device-status test command: ${command}`);
          },
        },
      });
    },
    { connected, customTitlebar },
  );
  await page.goto("/");
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
}

test("connection status is inline, uses the four requested labels and hides the raw error", async ({
  page,
}) => {
  await fixture(page);
  const name = page.locator(".sidebar-device-name");
  const status = name.locator(".device-connection-status");
  await expect(name).toHaveText("BW150 V1.1.0 (USB)");
  await expect(status).toHaveCSS(
    "color",
    rgb(webLightTheme.colorStatusSuccessForeground1),
  );
  const labelBox = (await name.locator("strong").boundingBox())!;
  const statusBox = (await status.boundingBox())!;
  expect(Math.abs(labelBox.y - statusBox.y)).toBeLessThan(2);
  await page.evaluate(() => {
    (window as any).statusFixture.device.transport = "bluetooth";
  });
  await expect(status).toHaveText("(BLE)");
  await page.evaluate(() => {
    (window as any).statusFixture.error = "设备没有连接。 (os error 1167)";
  });
  await expect(status).toHaveText("(异常)");
  await expect(status).toHaveCSS(
    "color",
    rgb(webLightTheme.colorStatusDangerForeground1),
  );
  await expect(page.locator(".device-error")).toHaveCount(0);
  await expect(
    page.getByText("设备没有连接。 (os error 1167)", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    Object.assign((window as any).statusFixture, {
      connected: false,
      error: null,
    });
  });
  await expect(name).toHaveText("BW150 V1.1.0 (未连接)");
  await page.evaluate(() => {
    (window as any).statusFixture.device = null;
  });
  await expect(name).toHaveText("(未连接)");
  await expect(status).toHaveCSS(
    "color",
    rgb(webLightTheme.colorStatusDangerForeground1),
  );
});

test("thermal readings are four independent metric cards on desktop and mobile", async ({
  page,
}) => {
  await fixture(page);
  for (const width of [1440, 393]) {
    await page.setViewportSize({ width, height: 1050 });
    await expect(page.locator(".metric")).toHaveCount(10);
    await expect(page.locator(".thermal-metrics > .metric")).toHaveCount(4);
    await expect(page.locator(".thermal-metrics h2")).toHaveText([
      "CPU 温度",
      "MOS 温度",
      "NTC 温度",
      "风扇转速",
    ]);
    await expect(
      page.getByRole("heading", { name: "温度与散热", exact: true }),
    ).toHaveCount(0);
    for (const [key, value, unit] of [
      ["cpuTemperature", "31.0", "°C"],
      ["ntcTemperature", "20.5", "°C"],
      ["mosTemperature", "26.0", "°C"],
      ["fanSpeed", "1200", "RPM"],
    ]) {
      const card = page.locator(`.thermal-metrics [data-measurement="${key}"]`);
      await expect(card.locator(".metric-number")).toHaveText(value);
      await expect(card.locator(".metric-unit")).toHaveText(unit);
      const styles = (element: Element) => {
        const style = getComputedStyle(element);
        return [
          style.padding,
          style.borderRadius,
          style.backgroundColor,
          element.getBoundingClientRect().height,
        ];
      };
      expect(await card.evaluate(styles)).toEqual(
        await page
          .locator('.metric[data-measurement="voltage"]')
          .evaluate(styles),
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: `${artifacts}/metrics-light-${width}.png`,
      fullPage: true,
    });
  }
});

test("temperature selectors, appearance settings and sample columns use CPU MOS NTC order", async ({
  page,
}) => {
  await fixture(page);
  const labels = await page
    .locator(".chart-controls .series-label")
    .allTextContents();
  expect(labels.indexOf("CPU 温度")).toBeLessThan(labels.indexOf("MOS 温度"));
  expect(labels.indexOf("MOS 温度")).toBeLessThan(labels.indexOf("NTC 温度"));
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await expect(page.locator(".floating-load-control")).toHaveCount(0);
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  const titles = await page.locator(".curve-settings h2").allTextContents();
  expect(titles.indexOf("CPU 温度")).toBeLessThan(titles.indexOf("MOS 温度"));
  expect(titles.indexOf("MOS 温度")).toBeLessThan(titles.indexOf("NTC 温度"));
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(page.locator(".floating-load-control")).toHaveCount(0);
  const columns = await page
    .getByRole("table", { name: "采样明细" })
    .getByRole("columnheader")
    .allTextContents();
  expect(columns.indexOf("CPU 温度 / °C")).toBeLessThan(
    columns.indexOf("MOS 温度 / °C"),
  );
  expect(columns.indexOf("MOS 温度 / °C")).toBeLessThan(
    columns.indexOf("NTC 温度 / °C"),
  );
});

test("recording settings default off, work without a device and survive restart", async ({
  page,
}) => {
  await fixture(page, false);
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  const tabs = page
    .getByRole("tablist", { name: "应用设置分类" })
    .getByRole("tab");
  await expect(tabs).toHaveCount(4);
  for (const [index, label] of ["外观", "曲线", "记录", "连接"].entries())
    await expect(tabs.nth(index)).toHaveAccessibleName(label);
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  const control = page.getByRole("combobox", {
    name: "自动记录",
    exact: true,
  });
  await expect(control).toBeEnabled();
  await expect(control).toHaveValue("off");
  await control.selectOption("device");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await expect(control).toHaveValue("device");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).statusFixture.calls
        .filter((call: any) => call.command === "set_auto_recording")
        .map((call: any) => call.args.settings.mode),
    ),
  ).toEqual(["device"]);
  await page.reload();
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  await expect(control).toHaveValue("device");
  await control.selectOption("off");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await expect(control).toHaveValue("off");
  expect(
    await page.evaluate(() =>
      (window as any).statusFixture.calls.some(
        (call: any) => call.command === "send_command",
      ),
    ),
  ).toBe(false);
});

test("native titlebar follows the sidebar palette on initial load and each theme change", async ({
  page,
}) => {
  await fixture(page, true, true);
  const lastTheme = () =>
    page.evaluate(
      () =>
        (window as any).statusFixture.calls
          .filter((call: any) => call.command === "set_window_theme")
          .at(-1)?.args,
    );
  await expect.poll(lastTheme).toEqual({
    dark: false,
    followSystem: true,
    background: webLightTheme.colorNeutralBackground3,
    foreground: webLightTheme.colorNeutralForeground1,
  });
  const titlebar = page.getByRole("banner", { name: "窗口标题栏" });
  await expect(titlebar).toHaveCSS(
    "background-color",
    rgb(webLightTheme.colorNeutralBackground3),
  );
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await expect.poll(lastTheme).toEqual({
    dark: true,
    followSystem: false,
    background: webDarkTheme.colorNeutralBackground3,
    foreground: webDarkTheme.colorNeutralForeground1,
  });
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    rgb(webDarkTheme.colorNeutralBackground3),
  );
  await expect(titlebar).toHaveCSS(
    "background-color",
    rgb(webDarkTheme.colorNeutralBackground3),
  );
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: `${artifacts}/metrics-dark-1440.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("light");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await expect.poll(lastTheme).toEqual({
    dark: false,
    followSystem: false,
    background: webLightTheme.colorNeutralBackground3,
    foreground: webLightTheme.colorNeutralForeground1,
  });
});

test("custom titlebar retains drag and window control actions", async ({
  page,
}) => {
  await fixture(page, true, true);
  const titlebar = page.getByRole("banner", { name: "窗口标题栏" });
  await expect(titlebar).toBeVisible();
  expect(
    await titlebar.evaluate((element) => {
      const border = getComputedStyle(element, "::before");
      return {
        height: border.height,
        color: border.backgroundColor,
        pointerEvents: border.pointerEvents,
      };
    }),
  ).toEqual({
    height: "1px",
    color: rgb(webLightTheme.colorNeutralForeground1),
    pointerEvents: "none",
  });
  await titlebar.getByRole("button", { name: "最大化", exact: true }).click();
  await expect(
    titlebar.getByRole("button", { name: "还原窗口", exact: true }),
  ).toBeVisible();
  await titlebar.getByRole("button", { name: "还原窗口", exact: true }).click();
  await titlebar.getByRole("button", { name: "最小化", exact: true }).click();
  const dragRegion = (await page.locator(".window-drag-region").boundingBox())!;
  await page.mouse.move(dragRegion.x + 50, dragRegion.y + 15);
  await page.mouse.down();
  await page.mouse.move(dragRegion.x + 80, dragRegion.y + 15);
  await page.mouse.up();
  await titlebar.getByRole("button", { name: "关闭窗口", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).statusFixture.calls
        .filter(
          (call: any) =>
            call.command === "window_action" && call.args.action !== "state",
        )
        .map((call: any) => call.args.action),
    ),
  ).toEqual(["maximize", "maximize", "minimize", "drag", "close"]);
});

for (const width of [900, 1440]) {
  test(`page scrolling starts below the titlebar and keeps its controls at the window edge (${width}px)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await fixture(page, true, true);
    // The modal correctly hides background landmarks from the accessibility
    // tree; inspect the still-rendered titlebar geometry through its element.
    const titlebar = page.locator(".window-titlebar");
    const shell = page.locator(".main-shell");
    await expect(page.locator("html")).toHaveClass("has-window-titlebar");
    const frame = (await titlebar.boundingBox())!;
    const viewport = (await shell.boundingBox())!;
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    expect(frame.width).toBe(width);
    expect(viewport.y).toBe(frame.height);
    expect(viewport.height + viewport.y).toBe(700);
    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBe(width);
    expect(
      await shell.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await shell.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await shell.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(
      0,
    );
    expect((await titlebar.boundingBox())!).toEqual(frame);
    const close = (await titlebar
      .getByRole("button", { name: "关闭窗口", exact: true })
      .boundingBox())!;
    expect(close.x + close.width).toBe(width);
    await page.getByRole("button", { name: "管理设备", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect((await titlebar.boundingBox())!.width).toBe(width);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    expect((await titlebar.boundingBox())!.width).toBe(width);
    await page.screenshot({
      path: testInfo.outputPath(`titlebar-scroll-${width}.png`),
    });
  });
}
