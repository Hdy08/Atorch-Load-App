import { expect, test, type Page } from "@playwright/test";
import { chooseMenu } from "./menu";

async function fixture(page: Page, mobile: boolean) {
  await page.addInitScript((mobile) => {
    if (mobile)
      Object.defineProperty(navigator, "userAgent", {
        value:
          "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36",
      });
    if (!localStorage.getItem("atorch-appearance"))
      localStorage.setItem(
        "atorch-appearance",
        JSON.stringify({ theme: "dark", scale: mobile ? 75 : 100 }),
      );
    const settings = {
      mode: 0,
      target: 1,
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
      voltage: 12,
      current: 0,
      power: 0,
      resistance: 0,
      energy: 0,
      capacity: 0,
      running: false,
      status: 0,
    };
    const calls: unknown[] = [];
    Object.assign(window, {
      isTauri: true,
      floatingMenuSettings: settings,
      floatingMenuCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: any) => {
          if (command === "get_system_accent") return "#8764b8";
          if (command === "send_command") {
            calls.push(args.command);
            Object.assign(settings, {
              [args.command.kind]: args.command.value,
            });
            return null;
          }
          if (command === "get_history")
            return [sample, { ...sample, timestamp: sample.timestamp + 1000 }];
          if (command === "get_snapshot")
            return {
              connected: true,
              device: {
                path: "layout-only",
                name: "BW150 · 模拟设备",
                transport: "usb",
              },
              settings: { ...settings },
              telemetry: sample,
              connectedAt: 1,
              lastReportAt: sample.timestamp,
              sampleCount: 2,
              samplingPaused: false,
              usbSampleRateHz: 1,
              recording: null,
              logs: [],
              error: null,
            };
          return null;
        },
      },
    });
  }, mobile);
  await page.goto("/");
  await expect(
    page.getByRole("spinbutton", { name: "目标电流快速设定", exact: true }),
  ).toBeVisible();
}

for (const mobile of [false, true]) {
  test(`floating spin buttons return focus for Enter without applying a value early (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    const input = page.getByRole("spinbutton", {
      name: "目标电流快速设定",
      exact: true,
    });
    const up = page.getByRole("button", {
      name: "增加目标电流快速设定",
      exact: true,
    });
    const down = page.getByRole("button", {
      name: "减少目标电流快速设定",
      exact: true,
    });
    const calls = () => page.evaluate(() => (window as any).floatingMenuCalls);
    await up.click();
    await expect(input).toHaveValue("1.100");
    await expect(input).toBeFocused();
    expect(await calls()).toEqual([]);
    await page.keyboard.press("Enter");
    await expect
      .poll(calls)
      .toEqual([{ kind: "target", value: 1.1, expectedMode: 0 }]);
    await expect(input).toBeEnabled();
    await down.click();
    await expect(input).toHaveValue("1.000");
    await expect(input).toBeFocused();
    expect(await calls()).toHaveLength(1);
    await page.keyboard.press("Enter");
    await expect.poll(calls).toHaveLength(2);
    await expect(input).toBeEnabled();
    await input.fill("9.900");
    await up.click();
    await expect(input).toHaveValue("10.000");
    await expect(up).toBeDisabled();
    await expect(input).toBeFocused();
    expect(await calls()).toHaveLength(2);
    await page.keyboard.press("Enter");
    await expect.poll(calls).toEqual([
      { kind: "target", value: 1.1, expectedMode: 0 },
      { kind: "target", value: 1, expectedMode: 0 },
      { kind: "target", value: 10, expectedMode: 0 },
    ]);
  });

  test(`floating target has equal label gaps, standard spin padding and stays anchored on reentry (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    const dock = page.locator(".floating-load-control");
    const geometry = await dock.evaluate((element) => {
      const mode = element.querySelector(".mode-code")!.getBoundingClientRect();
      const label = element
        .querySelector(".floating-load-target > span")!
        .getBoundingClientRect();
      const input = element
        .querySelector(".numeric-input")!
        .getBoundingClientRect();
      const scale = Number(
        getComputedStyle(element).getPropertyValue("--ui-scale"),
      );
      return {
        left: (label.left - mode.right) / scale,
        right: (input.left - label.right) / scale,
        width: input.width / scale,
      };
    });
    expect(geometry.left).toBeCloseTo(8, 1);
    expect(geometry.right).toBeCloseTo(geometry.left, 1);
    expect(geometry.width).toBeCloseTo(120, 1);
    const spinPadding = (selector: string) =>
      page.locator(selector).evaluate((element) => {
        const root = element.getBoundingClientRect();
        const spin = element
          .querySelector(".fui-SpinButton__incrementButton")!
          .getBoundingClientRect();
        const scale = Number(
          getComputedStyle(element).getPropertyValue("--ui-scale"),
        );
        return {
          padding: getComputedStyle(element).paddingRight,
          margin: (root.right - spin.right) / scale,
        };
      });
    const floatingPadding = await spinPadding(
      ".floating-load-target .numeric-input",
    );
    await page
      .getByRole("button", { name: "负载控制设置", exact: true })
      .click();
    const parameter = page.locator(".load-parameter .numeric-input").filter({
      has: page.getByRole("spinbutton", { name: "充放电流上限", exact: true }),
    });
    await expect(parameter).toBeVisible();
    const standardPadding = await parameter.evaluate((element) => {
      const root = element.getBoundingClientRect();
      const spin = element
        .querySelector(".fui-SpinButton__incrementButton")!
        .getBoundingClientRect();
      const scale = Number(
        getComputedStyle(element).getPropertyValue("--ui-scale"),
      );
      return {
        padding: getComputedStyle(element).paddingRight,
        margin: (root.right - spin.right) / scale,
      };
    });
    expect(floatingPadding.padding).toBe(standardPadding.padding);
    expect(floatingPadding.margin).toBeCloseTo(standardPadding.margin, 1);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await dock.screenshot({ path: info.outputPath("floating-control.png") });
    for (const transition of ["slide", "scale", "fade"]) {
      await page.evaluate((transition) => {
        const appearance = JSON.parse(
          localStorage.getItem("atorch-appearance")!,
        );
        localStorage.setItem(
          "atorch-appearance",
          JSON.stringify({ ...appearance, transition }),
        );
      }, transition);
      await page.reload();
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
      await expect(dock).toHaveCount(0);
      await page.evaluate(() => {
        const frames: { x: number; right: number }[] = [];
        Object.assign(window, { floatingMenuFrames: frames });
        const start = performance.now();
        const sample = () => {
          const control = document.querySelector(".floating-load-control");
          if (control) {
            const box = control.getBoundingClientRect();
            frames.push({ x: box.left, right: box.right });
          }
          if (performance.now() - start < 600) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.getByRole("button", { name: "实时监控", exact: true }).click();
      await page.waitForTimeout(650);
      const frames = await page.evaluate(
        () =>
          (window as any).floatingMenuFrames as { x: number; right: number }[],
      );
      expect(frames.length).toBeGreaterThan(3);
      expect(
        Math.max(...frames.map((frame) => frame.x)) -
          Math.min(...frames.map((frame) => frame.x)),
      ).toBeLessThan(1);
      expect(
        Math.max(...frames.map((frame) => frame.right)) -
          Math.min(...frames.map((frame) => frame.right)),
      ).toBeLessThan(1);
    }
    await page.evaluate(() =>
      Object.assign((window as any).floatingMenuSettings, {
        mode: 2,
        target: 9999.99,
      }),
    );
    await expect(
      page.getByRole("spinbutton", { name: "目标电阻快速设定", exact: true }),
    ).toHaveValue("9999.99");
    await dock.screenshot({ path: info.outputPath("floating-cr-maximum.png") });
  });

  test(`selection popup matches its trigger without moving the toolbar at different scales (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, mobile);
    for (const scale of [75, 100, 125, 200]) {
      await page.evaluate((scale) => {
        const appearance = JSON.parse(
          localStorage.getItem("atorch-appearance")!,
        );
        localStorage.setItem(
          "atorch-appearance",
          JSON.stringify({ ...appearance, scale }),
        );
      }, scale);
      await page.reload();
      await expect(page.locator(".trend-chart canvas")).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const time = page.getByRole("button", {
        name: "曲线时间坐标",
        exact: true,
      });
      await time.scrollIntoViewIfNeeded();
      const before = (await time.boundingBox())!;
      const layoutInfo = () =>
        page.evaluate(() => {
          const main = document.querySelector("main")!;
          const shell = document.querySelector(".main-shell")!;
          const chart = document.querySelector(".chart-card")!;
          return {
            main: main.getBoundingClientRect().toJSON(),
            shell: shell.getBoundingClientRect().toJSON(),
            chart: chart.getBoundingClientRect().toJSON(),
            padding: getComputedStyle(main).padding,
            gutter: getComputedStyle(main).getPropertyValue("--page-scrollbar"),
            client: shell.clientWidth,
            offset: (shell as HTMLElement).offsetWidth,
            body: document.body.getBoundingClientRect().toJSON(),
          };
        });
      const beforeLayout = await layoutInfo();
      await time.click();
      const menu = page.locator(".selection-menu");
      await expect(menu).toBeVisible();
      await expect
        .poll(async () =>
          Math.abs(
            (await menu.boundingBox())!.width -
              (await time.boundingBox())!.width,
          ),
        )
        .toBeLessThan(1);
      const after = (await time.boundingBox())!;
      expect(
        after.x,
        JSON.stringify({
          before,
          after,
          beforeLayout,
          afterLayout: await layoutInfo(),
        }),
      ).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      const items = await menu.getByRole("menuitemradio").all();
      for (const item of items) {
        const bounds = (await item.boundingBox())!;
        expect(bounds.height / (scale / 100)).toBeCloseTo(32, 0);
      }
      await page.screenshot({
        path: info.outputPath(`time-menu-${scale}.png`),
        animations: "disabled",
      });
      await page
        .getByRole("menuitemradio", { name: "相对时间", exact: true })
        .click();
      await expect(time).toHaveText("相对时间");
      await time.press("Enter");
      await expect(
        page.getByRole("menuitemradio", { name: "相对时间", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(time).toBeFocused();
      await page.getByRole("button", { name: "应用设置", exact: true }).click();
      const theme = page.getByRole("button", { name: "主题", exact: true });
      await theme.click();
      await expect
        .poll(async () =>
          Math.abs(
            (await menu.boundingBox())!.width -
              (await theme.boundingBox())!.width,
          ),
        )
        .toBeLessThan(1);
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "记录", exact: true }).click();
      await chooseMenu(
        page.getByRole("button", { name: "自动记录", exact: true }),
        "threshold",
      );
      await page.getByRole("switch", { name: "开始阈值", exact: true }).check();
      const comparison = page.getByRole("button", {
        name: "开始条件",
        exact: true,
      });
      await comparison.click();
      await expect
        .poll(async () =>
          Math.abs(
            (await menu.boundingBox())!.width -
              (await comparison.boundingBox())!.width,
          ),
        )
        .toBeLessThan(1);
      for (const item of await menu.getByRole("menuitemradio").all())
        expect((await item.boundingBox())!.height / (scale / 100)).toBeCloseTo(
          32,
          0,
        );
      await page.keyboard.press("Escape");
    }
  });
}
