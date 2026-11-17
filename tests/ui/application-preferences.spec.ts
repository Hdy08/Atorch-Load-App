import { test, expect, type Page } from "@playwright/test";
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";

async function fixture(
  page: Page,
  options: {
    mobile?: boolean;
    connected?: boolean;
    preference?: string;
    scale?: number;
    nativeFrame?: boolean;
    systemDark?: boolean;
  } = {},
) {
  await page.addInitScript((options) => {
    const startTransition = document.startViewTransition?.bind(document);
    if (startTransition)
      document.startViewTransition = ((update: any) => {
        const transition = startTransition(update);
        (window as any).lastThemeTransition = transition;
        (window as any).themeTransitionCount =
          ((window as any).themeTransitionCount ?? 0) + 1;
        return transition;
      }) as typeof document.startViewTransition;
    (window as any).preferenceSystemDark = options.systemDark;
    if (options.mobile)
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36",
      });
    if (options.preference && !sessionStorage.getItem("fixture-preferences"))
      localStorage.setItem("atorch-auto-connect", options.preference);
    if (options.scale && !sessionStorage.getItem("fixture-preferences"))
      localStorage.setItem(
        "atorch-appearance",
        JSON.stringify({ scale: options.scale }),
      );
    sessionStorage.setItem("fixture-preferences", "1");
    const usb = {
      path: "usb-test",
      name: "BW150 V1.1.0",
      serial: "UI",
      vendorId: 0x483,
      productId: 0x5750,
      transport: "usb",
    };
    const ble = {
      ...usb,
      path: "ble://test",
      name: "BW150_BLE",
      transport: "bluetooth",
    };
    let device = options.connected === false ? null : usb;
    let autoRecordOnLoad = false,
      maximized = false;
    let autoRecording = JSON.parse(
      localStorage.getItem("fixture-recording") ?? "null",
    );
    const settings = {
      mode: 0,
      target: 0.1,
      cutoffVoltage: 2.5,
      overCurrent: 10,
      overPower: 400,
      fullVoltage: 4.2,
      cutoffCurrent: 0.05,
      mosLimit: 100,
      ntcLimit: 100,
      limitHours: 2,
      limitMinutes: 0,
    };
    const sample = {
      timestamp: 1794902400000,
      voltage: 5,
      current: 0.1,
      power: 0.5,
      resistance: 50,
      energy: 0,
      capacity: 0,
      cpuTemperature: 25,
      mosTemperature: 26,
      ntcTemperature: 27,
      fanSpeed: 0,
      running: false,
      status: 0,
    };
    const calls: any[] = [];
    Object.assign(window, {
      isTauri: true,
      preferenceCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: any) => {
          calls.push({ command, args });
          if (command === "get_system_accent") return "#8764b8";
          if (command === "get_system_theme")
            return (window as any).preferenceSystemDark ?? null;
          if (command === "set_window_theme")
            return !options.mobile && !options.nativeFrame;
          if (command === "window_action") {
            if (args.action === "maximize") maximized = !maximized;
            return maximized;
          }
          if (command === "get_snapshot")
            return {
              connected: !!device,
              device,
              settings: device?.transport === "usb" ? settings : null,
              telemetry: device ? sample : null,
              connectedAt: 1,
              lastReportAt: sample.timestamp,
              sampleCount: 1,
              samplingPaused: true,
              autoRecordOnLoad,
              autoRecording: autoRecording ?? undefined,
              logs: [],
              recording: null,
              error: null,
            };
          if (command === "get_history") return [sample];
          if (command === "get_usb_diagnostics") return null;
          if (command === "get_bluetooth_status")
            return { supported: true, enabled: true, permission: true };
          if (command === "discover_devices") return [usb];
          if (command === "discover_bluetooth") return [ble];
          if (command === "connect_device") {
            device = args.path === usb.path ? usb : ble;
            return;
          }
          if (command === "disconnect_device") {
            device = null;
            return;
          }
          if (command === "stop_bluetooth_scan") return;
          if (command === "set_auto_record_on_load") {
            autoRecordOnLoad = args.enabled;
            return;
          }
          if (command === "set_auto_recording") {
            autoRecording = args.settings;
            localStorage.setItem(
              "fixture-recording",
              JSON.stringify(autoRecording),
            );
            return;
          }
          throw new Error(`Unexpected preference fixture command: ${command}`);
        },
      },
    });
  }, options);
  await page.goto("/");
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await settle(page);
}
async function settle(page: Page) {
  await page.locator("main").evaluate(async (el) => {
    await Promise.all(
      el.getAnimations().map((a) => a.finished.catch(() => {})),
    );
  });
}
const apply = async (page: Page) => {
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.evaluate(async () => {
    await (window as any).lastThemeTransition?.finished;
  });
};
const reset = (page: Page) =>
  page.getByRole("button", { name: "恢复默认", exact: true }).click();

async function recordingControls(page: Page, screenshot: string) {
  await settings(page);
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "自动记录", exact: true });
  await expect(
    page.getByRole("heading", { name: "自动记录", exact: true }),
  ).toBeVisible();
  await expect(mode).toHaveValue("off");
  await expect(page.locator(".auto-recording-rule")).toHaveCount(0);
  await mode.selectOption("device");
  await expect(
    page.getByRole("switch", { name: "启动时开始", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("spinbutton", { name: "启动延迟", exact: true }),
  ).toHaveValue("0.0");
  await expect(
    page.getByRole("spinbutton", { name: "关闭延迟", exact: true }),
  ).toHaveValue("0.0");
  await page
    .getByRole("spinbutton", { name: "启动延迟", exact: true })
    .fill("1.5");
  await page
    .getByRole("spinbutton", { name: "关闭延迟", exact: true })
    .fill("2");
  await page.getByRole("switch", { name: "关闭时停止", exact: true }).uncheck();
  await expect(
    page.getByRole("spinbutton", { name: "关闭延迟", exact: true }),
  ).toBeDisabled();
  await mode.selectOption("threshold");
  await expect(
    page.getByRole("spinbutton", { name: "开始保持时间", exact: true }),
  ).toHaveValue("0.0");
  for (const name of ["开始阈值", "停止阈值"])
    await page.getByRole("switch", { name, exact: true }).check();
  await page
    .getByRole("combobox", { name: "开始参数", exact: true })
    .selectOption("current");
  await expect(
    page
      .getByRole("spinbutton", { name: "开始阈值", exact: true })
      .locator(".."),
  ).toContainText("A");
  await page
    .getByRole("combobox", { name: "开始条件", exact: true })
    .selectOption("greater");
  await page
    .getByRole("spinbutton", { name: "开始阈值", exact: true })
    .fill("0.125");
  await page
    .getByRole("spinbutton", { name: "开始保持时间", exact: true })
    .fill("2.5");
  await page
    .getByRole("combobox", { name: "停止参数", exact: true })
    .selectOption("power");
  await expect(
    page
      .getByRole("spinbutton", { name: "停止阈值", exact: true })
      .locator(".."),
  ).toContainText("W");
  await page
    .getByRole("combobox", { name: "停止条件", exact: true })
    .selectOption("less");
  await page
    .getByRole("spinbutton", { name: "停止阈值", exact: true })
    .fill("0.5");
  await page
    .getByRole("spinbutton", { name: "停止保持时间", exact: true })
    .fill("3");
  const before = await page.evaluate(
    () =>
      (window as any).preferenceCalls.filter(
        (c: any) => c.command === "get_snapshot",
      ).length,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).preferenceCalls.filter(
            (c: any) => c.command === "get_snapshot",
          ).length,
      ),
    )
    .toBeGreaterThan(before + 2);
  await expect(
    page.getByRole("spinbutton", { name: "开始阈值", exact: true }),
  ).toHaveValue("0.125");
  expect(
    await page.evaluate(() =>
      (window as any).preferenceCalls.filter(
        (c: any) => c.command === "set_auto_recording",
      ),
    ),
  ).toHaveLength(0);
  await expect(page.locator(".record-rule-time").first()).toContainText("保持");
  await apply(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).preferenceCalls.filter(
            (c: any) => c.command === "set_auto_recording",
          ).length,
      ),
    )
    .toBe(1);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fixture-recording")!),
  );
  expect(saved).toMatchObject({
    mode: "threshold",
    startOnLoad: { enabled: true, delaySeconds: 1.5 },
    stopOnLoad: { enabled: false, delaySeconds: 2 },
    startThreshold: {
      enabled: true,
      parameter: "current",
      comparison: "greater",
      value: 0.125,
      holdSeconds: 2.5,
    },
    stopThreshold: {
      enabled: true,
      parameter: "power",
      comparison: "less",
      value: 0.5,
      holdSeconds: 3,
    },
  });
  await page
    .locator(".fui-Toast")
    .filter({ hasText: "已保存" })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.screenshot({ path: screenshot });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.reload();
  await settings(page);
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  await expect(mode).toHaveValue("threshold");
  await expect(
    page.getByRole("spinbutton", { name: "开始保持时间", exact: true }),
  ).toHaveValue("2.5");
  await reset(page);
  await expect(mode).toHaveValue("off");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("fixture-recording")!).mode,
    ),
  ).toBe("threshold");
  await apply(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("fixture-recording")!).mode,
      ),
    )
    .toBe("off");
}

test("appearance drafts only apply on request, follow the system, and restore per tab", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  await fixture(page);
  await settings(page);
  await expect(
    page.getByRole("combobox", { name: "主题", exact: true }),
  ).toHaveValue("system");
  await expect(
    page.getByRole("combobox", { name: "侧栏", exact: true }),
  ).toHaveValue("auto");
  await expect(
    page.getByRole("spinbutton", { name: "界面缩放", exact: true }),
  ).toHaveValue("100");
  await expect(page.getByRole("combobox", { name: "强调色来源" })).toHaveValue(
    "system",
  );
  await expect(
    page.getByRole("textbox", { name: "强调色", exact: true }),
  ).toHaveValue("#8764b8");
  await page.screenshot({ path: info.outputPath("appearance-default.png") });
  const background = () =>
    page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor);
  const light = await background();
  await page
    .getByRole("combobox", { name: "主题", exact: true })
    .selectOption("dark");
  expect(await background()).toBe(light);
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await page
    .getByRole("combobox", { name: "自动连接" })
    .selectOption("ble-only");
  await page.getByRole("tab", { name: "外观", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "主题", exact: true }),
  ).toHaveValue("dark");
  await apply(page);
  expect(await background()).not.toBe(light);
  expect(
    await page.evaluate(() => localStorage.getItem("atorch-auto-connect")),
  ).toBe("prefer-usb");
  await reset(page);
  expect(await background()).not.toBe(light);
  await apply(page);
  expect(await background()).toBe(light);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background).not.toBe(light);
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "自动连接" })).toHaveValue(
    "ble-only",
  );
  await apply(page);
  await page.reload();
  await settings(page);
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "自动连接" })).toHaveValue(
    "ble-only",
  );
});

test("system theme apply reads Windows independently of forced WebView media and uses native transitions", async ({
  page,
}, info) => {
  await page.emulateMedia({
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await fixture(page, { nativeFrame: true, systemDark: true });
  const background = () =>
    page.locator(".app").evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(background).toBe("rgb(31, 31, 31)");
  await settings(page);
  const select = page.getByRole("combobox", { name: "主题", exact: true });
  const count = () =>
    page.evaluate(() => (window as any).themeTransitionCount ?? 0);
  const initial = await count();
  await select.selectOption("light");
  await apply(page);
  await expect.poll(background).toBe("rgb(250, 250, 250)");
  expect(await count()).toBe(initial + 1);
  await select.selectOption("system");
  await apply(page);
  await expect.poll(background).toBe("rgb(31, 31, 31)");
  expect(await count()).toBe(initial + 2);
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-color-scheme: dark)").matches,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (window as any).preferenceCalls
          .filter((c: any) => c.command === "set_window_theme")
          .at(-1).args.followSystem,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).preferenceSystemDark = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(background).toBe("rgb(250, 250, 250)");
  await page.evaluate(async () => {
    await (window as any).lastThemeTransition?.finished;
  });
  expect(await count()).toBe(initial + 3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await select.selectOption("dark");
  await apply(page);
  await expect.poll(background).toBe("rgb(31, 31, 31)");
  expect(await count()).toBe(initial + 3);
  await page.screenshot({ path: info.outputPath("system-theme-applied.png") });
});

test("automatic recording dropdown, delays, threshold units and holds are drafted and persisted", async ({
  page,
}, info) => {
  await fixture(page, { connected: false });
  await recordingControls(
    page,
    info.outputPath("automatic-recording-desktop.png"),
  );
});

test("automatic recording rejects invalid active durations and missing thresholds before native IPC", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  const mode = page.getByRole("combobox", { name: "自动记录", exact: true });
  await mode.selectOption("device");
  await page
    .getByRole("spinbutton", { name: "启动延迟", exact: true })
    .fill("-1");
  await apply(page);
  const toast = page.locator(".fui-Toast");
  await expect(toast).toContainText("启动延迟必须为非负的有效秒数");
  await toast.getByRole("button", { name: "关闭", exact: true }).click();
  await mode.selectOption("threshold");
  await page.getByRole("switch", { name: "开始阈值", exact: true }).check();
  await page
    .getByRole("spinbutton", { name: "开始阈值", exact: true })
    .fill("");
  await apply(page);
  await expect(
    page.locator(".fui-Toast").filter({ hasText: "开始阈值请输入有效数值" }),
  ).toContainText("开始阈值请输入有效数值");
  expect(
    await page.evaluate(() =>
      (window as any).preferenceCalls.filter(
        (c: any) => c.command === "set_auto_recording",
      ),
    ),
  ).toHaveLength(0);
});

test("accent presets and picker apply through Fluent brand tokens and are remembered", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  const brand = () =>
    page
      .locator(".theme-root")
      .first()
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--colorBrandBackground").trim(),
      );
  const original = await brand();
  await page
    .getByRole("radio", { name: "强调色 #107c10", exact: true })
    .click();
  expect(await brand()).toBe(original);
  await apply(page);
  await expect.poll(brand).toBe("#107c10");
  const picker = page.getByLabel("强调色取色值", { exact: true });
  await picker.evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, "#d13438");
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(
    page.getByRole("textbox", { name: "强调色", exact: true }),
  ).toHaveValue("#d13438");
  await apply(page);
  await expect.poll(brand).toBe("#d13438");
  await page.reload();
  await settings(page);
  await expect(page.getByRole("combobox", { name: "强调色来源" })).toHaveValue(
    "custom",
  );
  await expect.poll(brand).toBe("#d13438");
});

for (const percent of [50, 125, 200])
  test(`UI zoom ${percent}% preserves viewport, physical insets and floating alignment`, async ({
    page,
  }, info) => {
    await fixture(page);
    await settings(page);
    const input = page.getByRole("spinbutton", {
      name: "界面缩放",
      exact: true,
    });
    await input.fill(String(percent));
    await apply(page);
    await expect(page.locator("body")).toHaveCSS("zoom", String(percent / 100));
    const title = (await page.locator(".window-titlebar").boundingBox())!;
    expect(title.height).toBeCloseTo(32, 0);
    expect(title.width).toBeCloseTo(1440, 0);
    const app = (await page.locator(".app").boundingBox())!;
    expect(app.height).toBeCloseTo(1050, 0);
    const shell = (await page.locator(".main-shell").boundingBox())!;
    const card = (await page
      .locator(".appearance-settings .fui-Card")
      .first()
      .boundingBox())!;
    expect(card.x - shell.x).toBeCloseTo(24, 0);
    const toast = page
      .locator(".fui-Toast")
      .filter({ hasText: "已保存" })
      .last();
    await expect(toast).toBeVisible();
    await toast.evaluate(async (el) => {
      await Promise.all(
        el
          .parentElement!.getAnimations({ subtree: true })
          .map((a) => a.finished.catch(() => {})),
      );
    });
    const notice = (await toast.boundingBox())!;
    const content = (await page.locator(".appearance-settings").boundingBox())!;
    const actions = (await page
      .locator(".application-settings-actions")
      .boundingBox())!;
    expect(notice.x + notice.width).toBeCloseTo(content.x + content.width, 0);
    expect(notice.width).toBeLessThanOrEqual(content.width + 1);
    expect(notice.y - actions.y - actions.height).toBeCloseTo(
      (16 * percent) / 100,
      0,
    );
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await settle(page);
    const row = (await page.locator(".metrics").first().boundingBox())!;
    const dock = (await page.locator(".floating-load-control").boundingBox())!;
    expect(dock.x + dock.width).toBeCloseTo(row.x + row.width, 0);
    expect(row.x - shell.x).toBeCloseTo(24, 0);
    const handle = page.getByRole("button", { name: "拖动负载控制器" });
    const before = (await handle.boundingBox())!;
    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(before.x - 40, before.y + 120, { steps: 5 });
    await page.mouse.up();
    const after = (await handle.boundingBox())!;
    expect(after.y).toBeGreaterThan(before.y + 80);
    await page.screenshot({ path: info.outputPath(`zoom-${percent}.png`) });
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect
      .poll(async () => {
        const rect = (await page
          .locator("dialog:modal .trend-chart")
          .boundingBox())!;
        return [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
        ];
      })
      .toEqual([0, 0, 1440, 1050]);
    await expect
      .poll(() =>
        page
          .locator("dialog:modal canvas")
          .first()
          .evaluate((canvas: HTMLCanvasElement) => canvas.width),
      )
      .toBe(1440);
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  });

test("desktop margins stay 24px across window widths, including very wide windows", async ({
  page,
}) => {
  await fixture(page);
  for (const width of [850, 1440, 2400, 3200, 1000]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(async () => {
        const row = (await page.locator(".metrics").first().boundingBox())!;
        const shell = (await page.locator(".main-shell").boundingBox())!;
        return Math.round(row.x - shell.x);
      })
      .toBe(24);
    const row = (await page.locator(".metrics").first().boundingBox())!;
    expect(width - row.x - row.width).toBeCloseTo(24, 0);
  }
});

test("sidebar can stay expanded or collapsed independently of desktop width", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  for (const [choice, width, expected] of [
    ["expanded", 850, 228],
    ["collapsed", 1800, 72],
    ["auto", 850, 72],
    ["auto", 1800, 228],
  ] as const) {
    await page.setViewportSize({ width, height: 1050 });
    await page
      .getByRole("combobox", { name: "侧栏", exact: true })
      .selectOption(choice);
    await apply(page);
    await expect(page.locator(".sidebar")).toHaveCSS("width", `${expected}px`);
  }
});

test("curve and recording changes are applied and reset only by their own header buttons", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "电压线宽", exact: true })
    .fill("2");
  expect(
    await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
  ).toBe("{}");
  await apply(page);
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")))!,
    ).voltage.width,
  ).toBe(2);
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  const recordingMode = page.getByRole("combobox", {
    name: "自动记录",
    exact: true,
  });
  await recordingMode.selectOption("device");
  expect(
    await page.evaluate(() =>
      (window as any).preferenceCalls.filter(
        (c: any) => c.command === "set_auto_recording",
      ),
    ),
  ).toHaveLength(0);
  await apply(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).preferenceCalls.filter(
            (c: any) => c.command === "set_auto_recording",
          ).length,
      ),
    )
    .toBe(1);
  await reset(page);
  await expect(recordingMode).toHaveValue("off");
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")))!,
    ).voltage.width,
  ).toBe(2);
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
  await reset(page);
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")))!,
    ).voltage.width,
  ).toBe(2);
  await apply(page);
  expect(
    await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
  ).toBe("{}");
});

for (const [preference, path, first] of [
  ["prefer-usb", "usb-test", "discover_devices"],
  ["prefer-ble", "ble://test", "discover_bluetooth"],
  ["usb-only", "usb-test", "discover_devices"],
  ["ble-only", "ble://test", "discover_bluetooth"],
])
  test(`saved connection mode ${preference} uses the chosen transport`, async ({
    page,
  }) => {
    await fixture(page, { connected: false, preference });
    await expect(
      page.getByRole("button", { name: "管理设备", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    const calls = await page.evaluate(() => (window as any).preferenceCalls);
    expect(
      calls.find((c: any) => c.command === "connect_device").args.path,
    ).toBe(path);
    expect(
      calls.find(
        (c: any) =>
          c.command === "discover_devices" ||
          c.command === "discover_bluetooth",
      ).command,
    ).toBe(first);
    if (preference === "usb-only")
      expect(calls.some((c: any) => c.command === "get_bluetooth_status")).toBe(
        false,
      );
    if (preference === "ble-only")
      expect(calls.some((c: any) => c.command === "discover_devices")).toBe(
        false,
      );
  });

test("off disables scans; connection draft starts scanning only after apply", async ({
  page,
}) => {
  await fixture(page, { connected: false, preference: "off" });
  await settings(page);
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await page
    .getByRole("combobox", { name: "自动连接" })
    .selectOption("prefer-ble");
  await page.waitForTimeout(2000);
  expect(
    await page.evaluate(() =>
      (window as any).preferenceCalls.some((c: any) =>
        /^(discover_devices|discover_bluetooth|connect_device)$/.test(
          c.command,
        ),
      ),
    ),
  ).toBe(false);
  await apply(page);
  await expect(
    page.getByRole("button", { name: "管理设备", exact: true }),
  ).toBeVisible({ timeout: 10000 });
});

test("titlebar double-click toggles maximization twice without starting window drag", async ({
  page,
}) => {
  await fixture(page);
  const region = page.locator(".window-drag-region");
  await region.dblclick();
  await expect(
    page.getByRole("button", { name: "还原窗口", exact: true }),
  ).toBeVisible();
  await region.dblclick();
  await expect(
    page.getByRole("button", { name: "最大化", exact: true }),
  ).toBeVisible();
  const actions = () =>
    page.evaluate(() =>
      (window as any).preferenceCalls
        .filter(
          (c: any) =>
            c.command === "window_action" && c.args.action !== "state",
        )
        .map((c: any) => c.args.action),
    );
  expect(await actions()).toEqual(["maximize", "maximize"]);
  const rect = (await region.boundingBox())!;
  await page.mouse.move(rect.x + 150, rect.y + 15);
  await page.mouse.down();
  await page.mouse.move(rect.x + 180, rect.y + 15);
  await page.mouse.up();
  expect(await actions()).toEqual(["maximize", "maximize", "drag"]);
});

test.describe("mobile safe viewport and navigation", () => {
  test.use({
    viewport: { width: 393, height: 850 },
    isMobile: true,
    hasTouch: true,
  });
  test("device button is the rightmost equal-size tab and portrait margins stay 16px", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, scale: 100 });
    for (const width of [393, 800]) {
      await page.setViewportSize({ width, height: 850 });
      const buttons = page.locator(".sidebar button");
      await expect(buttons).toHaveCount(5);
      const boxes = await buttons.evaluateAll((nodes) =>
        nodes.map((el) => el.getBoundingClientRect().toJSON()),
      );
      for (const box of boxes) {
        expect(box.y).toBeCloseTo(boxes[0].y, 1);
        expect(box.width).toBeCloseTo(boxes[0].width, 1);
        expect(box.height).toBe(boxes[0].height);
      }
      expect(boxes[4].x).toBeGreaterThan(boxes[3].x);
      const row = (await page.locator(".metrics").first().boundingBox())!;
      expect(row.x).toBeCloseTo(16, 0);
      expect(width - row.x - row.width).toBeCloseTo(16, 0);
      await page.screenshot({ path: info.outputPath(`mobile-${width}.png`) });
    }
  });
  test("mobile scaling keeps the viewport and fixed physical page insets", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, scale: 100 });
    await settings(page);
    for (const percent of [50, 200, 100]) {
      await page
        .getByRole("spinbutton", { name: "界面缩放", exact: true })
        .fill(String(percent));
      await apply(page);
      const app = (await page.locator(".app").boundingBox())!;
      expect(app.width).toBeCloseTo(393, 0);
      expect(app.height).toBeCloseTo(850, 0);
      const card = (await page
        .locator(".appearance-settings .fui-Card")
        .first()
        .boundingBox())!;
      expect(card.x).toBeCloseTo(16, 0);
      expect(393 - card.x - card.width).toBeCloseTo(16, 0);
      await page.screenshot({
        path: info.outputPath(`mobile-zoom-${percent}.png`),
      });
      if (percent === 200) {
        await page.getByRole("tab", { name: "连接", exact: true }).click();
        await expect(
          page.getByRole("combobox", { name: "自动连接" }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "外观", exact: true }).click();
      }
    }
  });
  test("portrait underline slides between tabs and landscape uses the desktop sidebar", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, scale: 100 });
    const sidebar = page.locator(".sidebar");
    const indicator = page.locator(".mobile-nav-indicator");
    await expect(sidebar).toHaveCSS("border-top-width", "0px");
    await indicator.evaluate((element) => {
      (window as any).navTransitions = [];
      element.addEventListener("transitionrun", (event) => {
        (window as any).navTransitions.push(
          (event as TransitionEvent).propertyName,
        );
      });
    });
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).navTransitions))
      .toContain("transform");
    await indicator.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const selected = page.locator('.nav-item[aria-current="page"]');
    const tab = (await selected.boundingBox())!;
    const underline = (await indicator.boundingBox())!;
    expect(underline.x + underline.width / 2).toBeCloseTo(
      tab.x + tab.width / 2,
      0,
    );
    expect(underline.y + underline.height).toBeCloseTo(tab.y + tab.height, 0);
    expect(underline.height).toBe(3);
    expect(
      await selected.evaluate(
        (element) => getComputedStyle(element, "::after").content,
      ),
    ).toBe("none");
    await page.screenshot({ path: info.outputPath("portrait-navigation.png") });
    await page.setViewportSize({ width: 850, height: 393 });
    await expect(page.locator(".app")).not.toHaveClass(/mobile-layout/);
    await expect(sidebar).toHaveCSS("width", "72px");
    await expect(indicator).toBeHidden();
    await expect(sidebar).toHaveCSS("padding", "16px");
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await settle(page);
    const shell = (await page.locator(".main-shell").boundingBox())!;
    const row = (await page.locator(".metrics").first().boundingBox())!;
    expect(row.x - shell.x).toBeCloseTo(16, 0);
    expect(850 - row.x - row.width).toBeCloseTo(16, 0);
    await page.screenshot({ path: info.outputPath("landscape-sidebar.png") });
    await page.setViewportSize({ width: 393, height: 850 });
    await expect(page.locator(".app")).toHaveClass(/mobile-layout/);
    await expect(indicator).toBeVisible();
  });
  test("phone headings keep compact spacing and settings notices clear the header buttons", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, scale: 100 });
    for (const name of ["实时监控", "数据记录", "设备设置", "应用设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await settle(page);
      const heading = page.locator(".page-heading");
      const bounds = await heading.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          gap:
            element.nextElementSibling!.getBoundingClientRect().top -
            rect.bottom,
          lineHeight: getComputedStyle(element.querySelector("h1")!).lineHeight,
        };
      });
      expect(bounds.height).toBe(name === "实时监控" ? 84 : 32);
      expect(bounds.gap).toBe(16);
      expect(bounds.lineHeight).toBe("32px");
    }
    await apply(page);
    const toast = page.locator(".fui-Toast").filter({ hasText: "已保存" });
    await expect(toast).toBeVisible();
    await toast.evaluate(async (element) => {
      await Promise.all(
        element
          .parentElement!.getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    const actions = (await page
      .locator(".application-settings-actions")
      .boundingBox())!;
    const notice = (await toast.boundingBox())!;
    expect(notice.y - actions.y - actions.height).toBeCloseTo(16, 0);
    expect(notice.x + notice.width).toBeCloseTo(377, 0);
    await page.screenshot({
      path: info.outputPath("compact-settings-toast.png"),
    });
  });
});

test.describe("compact Android headers", () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 850 },
  });
  test("phone default and restored zoom is 75 percent while saved zoom is retained", async ({
    page,
  }) => {
    await fixture(page, { mobile: true });
    await expect(page.locator("body")).toHaveCSS("zoom", "0.75");
    await settings(page);
    const scale = page.getByRole("spinbutton", {
      name: "界面缩放",
      exact: true,
    });
    await expect(scale).toHaveValue("75");
    await scale.fill("100");
    await apply(page);
    await page.reload();
    await settings(page);
    await expect(scale).toHaveValue("100");
    await reset(page);
    await expect(scale).toHaveValue("75");
    await apply(page);
    await expect(page.locator("body")).toHaveCSS("zoom", "0.75");
  });
  test("automatic recording fits the phone at its default 75 percent scale", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, connected: false });
    await recordingControls(
      page,
      info.outputPath("automatic-recording-phone.png"),
    );
  });
  test("disconnected portrait controller shares the title row; landscape tabs follow the compact title", async ({
    page,
  }, info) => {
    await fixture(page, { mobile: true, connected: false, scale: 100 });
    await settle(page);
    const heading = page.locator(".page-heading");
    const title = (await heading.locator("h1").boundingBox())!;
    const control = (await page
      .locator(".floating-load-control")
      .boundingBox())!;
    const card = (await page.locator(".metrics").first().boundingBox())!;
    expect(control.y).toBe(title.y);
    expect(control.x).toBeGreaterThan(title.x + title.width);
    expect(card.y - control.y - control.height).toBe(16);
    expect(control.y).toBe(16);
    await page.screenshot({
      path: info.outputPath("portrait-compact-live.png"),
    });
    await page.setViewportSize({ width: 850, height: 393 });
    for (const name of ["数据记录", "设备设置", "应用设置"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await settle(page);
      const geometry = await heading.evaluate((element) => {
        const title = element.querySelector("h1")!;
        return {
          lineHeight: getComputedStyle(title).lineHeight,
          height: element.getBoundingClientRect().height,
          gap:
            element.nextElementSibling!.getBoundingClientRect().top -
            element.getBoundingClientRect().bottom,
        };
      });
      expect(geometry.lineHeight).toBe("32px");
      expect(geometry.height).toBe(32);
      expect(geometry.gap).toBe(16);
      await page.screenshot({ path: info.outputPath(`landscape-${name}.png`) });
    }
    await page.getByRole("button", { name: "实时监控", exact: true }).click();
    await settle(page);
    const landscapeTitle = (await heading.locator("h1").boundingBox())!;
    const landscapeControl = (await page
      .locator(".floating-load-control")
      .boundingBox())!;
    expect(landscapeControl.y).toBe(landscapeTitle.y);
    await page.screenshot({
      path: info.outputPath("landscape-compact-live.png"),
    });
  });
});

test("collapsed navigation centers its icons without moving icons or indicators between widths", async ({
  page,
}, info) => {
  await fixture(page);
  for (const width of [1440, 1200, 850, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toHaveCSS("width", width > 1200 ? "228px" : "72px");
    const geometry = await sidebar.evaluate((element) => {
      const root = element.getBoundingClientRect();
      const items = [...element.querySelectorAll<HTMLElement>(".nav-item")];
      return {
        padding: getComputedStyle(element).padding,
        top: items[0].getBoundingClientRect().top - root.top,
        bottom:
          root.bottom - items[items.length - 1].getBoundingClientRect().bottom,
        items: items.map((item) => {
          const icon = item
            .querySelector(".nav-item-icon")!
            .getBoundingClientRect();
          const rect = item.getBoundingClientRect();
          const marker = getComputedStyle(item, "::after");
          return {
            iconCenter: icon.left + icon.width / 2 - root.left,
            markerLeft: rect.left - root.left + parseFloat(marker.left),
            gap:
              icon.left -
              rect.left -
              parseFloat(marker.left) -
              parseFloat(marker.width),
            selected: item.getAttribute("aria-current") === "page",
          };
        }),
      };
    });
    expect(geometry.padding).toBe("16px");
    expect(geometry.top).toBe(16);
    expect(geometry.bottom).toBe(16);
    for (const item of geometry.items) expect(item.iconCenter).toBe(36);
    const selected = geometry.items.find((item) => item.selected)!;
    expect(selected.markerLeft).toBe(16);
    expect(selected.gap).toBeGreaterThanOrEqual(6);
    await page.screenshot({ path: info.outputPath(`sidebar-${width}.png`) });
  }
  await page.mouse.move(500, 20);
  const selected = page.getByRole("button", { name: "实时监控", exact: true });
  const other = page.getByRole("button", { name: "数据记录", exact: true });
  await expect(selected).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(other).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await other.hover();
  await expect(other).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("right-click menus are suppressed on charts, inputs and portal dialogs", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).contextMenuResults = [];
    document.addEventListener("contextmenu", (event) => {
      (window as any).contextMenuResults.push(event.defaultPrevented);
    });
  });
  await page.locator(".trend-chart canvas").click({ button: "right" });
  await settings(page);
  await page
    .getByRole("spinbutton", { name: "界面缩放", exact: true })
    .click({ button: "right" });
  await page.getByRole("button", { name: "管理设备", exact: true }).click();
  await page.locator(".fui-DialogSurface").click({ button: "right" });
  expect(await page.evaluate(() => (window as any).contextMenuResults)).toEqual(
    [true, true, true],
  );
});

test("browser refresh and navigation shortcuts are disabled while text editing remains available", async ({
  page,
}) => {
  await fixture(page);
  await settings(page);
  const input = page.getByRole("spinbutton", { name: "界面缩放", exact: true });
  await input.fill("137");
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.evaluate(() => {
    (window as any).blockedKeys = [];
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented)
        (window as any).blockedKeys.push(event.key.toLowerCase());
    });
  });
  for (const key of [
    "F5",
    "Control+r",
    "Control+Shift+r",
    "F12",
    "Control+p",
    "Control+s",
    "Alt+ArrowLeft",
    "Control+-",
    "Control+0",
  ])
    await page.keyboard.press(key);
  expect(navigations).toBe(0);
  await expect(input).toHaveValue("137");
  expect(await page.evaluate(() => (window as any).blockedKeys)).toEqual([
    "f5",
    "r",
    "r",
    "f12",
    "p",
    "s",
    "arrowleft",
    "-",
    "0",
  ]);
  await input.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("150");
  await expect(input).toHaveValue("150");
  expect(
    await input.evaluate((element) =>
      ["c", "v", "x", "z", "y"].map((key) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    ),
  ).toEqual([true, true, true, true, true]);
});

test("native frame mode keeps title and header actions exactly at the desktop inset", async ({
  page,
}) => {
  await fixture(page, { nativeFrame: true });
  await settings(page);
  await expect(page.locator(".window-controls")).toHaveCount(0);
  await expect(page.locator(".app")).not.toHaveClass(/custom-titlebar/);
  for (const width of [850, 1440, 2000]) {
    await page.setViewportSize({ width, height: 960 });
    const shell = (await page.locator(".main-shell").boundingBox())!;
    const title = (await page
      .getByRole("heading", { name: "应用设置", exact: true })
      .boundingBox())!;
    const actions = (await page
      .locator(".application-settings-actions")
      .boundingBox())!;
    expect(title.y - shell.y).toBe(24);
    expect(actions.y - shell.y).toBe(24);
    expect(width - actions.x - actions.width).toBeCloseTo(24, 0);
  }
});

test("page scrollbar appears during scroll and near the edge, then hides without shifting content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 620 });
  await fixture(page);
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await settle(page);
  const shell = page.locator(".main-shell");
  await expect
    .poll(() =>
      shell.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await expect(shell).not.toHaveClass(/scrollbar-visible/);
  const before = await shell.evaluate((element) => element.clientWidth);
  await shell.evaluate((element) => element.scrollTo({ top: 200 }));
  await expect(shell).toHaveClass(/scrollbar-visible/);
  expect(await shell.evaluate((element) => element.clientWidth)).toBe(before);
  await expect(shell).not.toHaveClass(/scrollbar-visible/, { timeout: 3000 });
  expect(await shell.evaluate((element) => element.clientWidth)).toBe(before);
  await expect(shell).toHaveCSS(
    "scrollbar-color",
    "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)",
  );
  await page.mouse.move(1426, 120);
  await expect(shell).toHaveClass(/scrollbar-visible/);
});

test("official Navigation supplies the selection indicator and bundled icon states", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await fixture(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation).toHaveClass(/fui-Nav/);
  await expect(navigation.locator(".fui-NavItem")).toHaveCount(5);
  await expect(navigation.locator(".fui-ToggleButton")).toHaveCount(0);
  const live = navigation.getByRole("button", {
    name: "实时监控",
    exact: true,
  });
  await expect(live).toHaveAttribute("aria-current", "page");
  const indicator = await live.evaluate((el) => {
    const style = getComputedStyle(el, "::after");
    return { width: style.width, height: style.height, content: style.content };
  });
  expect(indicator).toEqual({ width: "4px", height: "20px", content: '""' });
  await expect(live.locator(".fui-Icon-filled")).toBeVisible();
  await navigation
    .getByRole("button", { name: "数据记录", exact: true })
    .click();
  await expect(
    navigation.getByRole("button", { name: "数据记录", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(live).not.toHaveAttribute("aria-current", "page");
  await expect(live.locator(".fui-Icon-filled")).toHaveCSS("display", "none");
  await page.screenshot({ path: info.outputPath("official-navigation.png") });
});
