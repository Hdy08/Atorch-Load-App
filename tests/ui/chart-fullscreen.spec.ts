import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const start = Date.now() - 120_000;
    const sample = (index: number) => ({
      timestamp: start + index * 1000,
      elapsedMs: index * 1000,
      voltage: 12 + index / 100,
      current: 1,
      power: 12,
      resistance: 12,
      energy: 0.4,
      capacity: 33,
      cpuTemperature: 30,
      ntcTemperature: 25,
      mosTemperature: 28,
      fanSpeed: 1000,
      running: null,
      status: 0,
    });
    const rows = Array.from({ length: 121 }, (_, index) => sample(index));
    const calls: { command: string; args: any }[] = [];
    Object.assign(window, {
      isTauri: true,
      fullscreenFixture: {
        calls,
        tick: () => rows.push(sample(rows.length)),
      },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: any) => {
          calls.push({ command, args });
          if (command === "get_snapshot")
            return {
              connected: true,
              device: { path: "fixture", name: "BW150", transport: "usb" },
              telemetry: rows.at(-1),
              settings: null,
              sampleCount: rows.length,
              connectedAt: start,
              lastReportAt: Date.now(),
              recording: "fixture.csv",
              logs: [],
            };
          if (command === "get_history") return [...rows];
          if (command === "list_recordings") return [];
          if (command === "set_chart_fullscreen") return;
          throw new Error(`Unexpected fullscreen command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
  await expect.poll(async () => (await chartState(page)).count).toBe(121);
}

async function chartState(page: Page, zoom = false) {
  return page.evaluate(async (zoom) => {
    const url = performance
      .getEntriesByType("resource")
      .map((item) => item.name)
      .find((name) => name.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    if (zoom) chart.dispatchAction({ type: "dataZoom", start: 20, end: 80 });
    const option = chart.getOption();
    return {
      id: chart.id,
      width: chart.getWidth(),
      height: chart.getHeight(),
      count: chart.getModel().getSeriesByIndex(0).getRawData().count(),
      range: [option.dataZoom[0].startValue, option.dataZoom[0].endValue],
      slider: option.dataZoom[1].show !== false,
      axes: option.yAxis.map((axis: any) => [axis.id, axis.min, axis.max]),
      savedHeight: localStorage.getItem("atorch-chart-height"),
    };
  }, zoom);
}

async function screenshot(page: Page, name: string) {
  const folder = "artifacts/large-csv/fullscreen";
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/${name}.png` });
}

async function expectScaledFullscreen(
  page: Page,
  width: number,
  height: number,
  rotated = false,
) {
  const scale = await page.evaluate(() =>
    Number(
      document.documentElement.style.getPropertyValue("--ui-scale") || "1",
    ),
  );
  await expect
    .poll(async () => (await chartState(page)).width)
    .toBe(Math.floor((rotated ? height : width) / scale));
  await expect
    .poll(async () => (await chartState(page)).height)
    .toBe(Math.floor((rotated ? width : height) / scale));
  const rect = await page.locator(".trend-chart").boundingBox();
  expect(rect!.x).toBeCloseTo(0, 0);
  expect(rect!.y).toBeCloseTo(0, 0);
  expect(rect!.width).toBeCloseTo(width, 0);
  expect(rect!.height).toBeCloseTo(height, 0);
}

test("desktop live and history fill the window, preserving zoom, data and card height", async ({
  page,
}) => {
  await fixture(page);
  for (const history of [false, true]) {
    if (history)
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
    const footer = page.locator(".chart-image-actions");
    const reset = await footer
      .getByRole("button", { name: "重置缩放" })
      .boundingBox();
    const full = await footer
      .getByRole("button", { name: "全屏", exact: true })
      .boundingBox();
    expect(full!.x).toBeGreaterThan(reset!.x + reset!.width);
    expect(full!.height).toBe(reset!.height);
    const before = await chartState(page, true);
    const box = await page.locator(".trend-chart").boundingBox();
    await page.mouse.move(box!.x + 40, box!.y + box!.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    const zoomed = await chartState(page);
    expect(zoomed.axes).not.toEqual(before.axes);
    await footer.getByRole("button", { name: "全屏", exact: true }).click();
    await expect(page.locator("dialog:modal")).toHaveAccessibleName("全屏曲线");
    await expect.poll(async () => (await chartState(page)).width).toBe(1440);
    await expect.poll(async () => (await chartState(page)).height).toBe(1050);
    expect(await page.locator(".trend-chart").boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 1050,
    });
    const fullState = await chartState(page);
    expect(fullState.id).toBe(before.id);
    expect(fullState.range).toEqual(zoomed.range);
    // Auto ranges may gain grid lines; the manually zoomed axis stays exact.
    expect(fullState.axes[0]).toEqual(zoomed.axes[0]);
    expect(fullState.axes.map((axis: any[]) => axis[0])).toEqual(
      zoomed.axes.map((axis: any[]) => axis[0]),
    );
    expect(fullState.slider).toBe(false);
    expect(
      await page.locator("dialog:modal").getByRole("button").allTextContents(),
    ).toEqual(["退出全屏"]);
    if (!history) {
      await page.evaluate(() => (window as any).fullscreenFixture.tick());
      await expect.poll(async () => (await chartState(page)).count).toBe(122);
    }
    await screenshot(page, history ? "desktop-history" : "desktop-live");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "全屏", exact: true }),
    ).toBeFocused();
    const restored = await chartState(page);
    expect(restored.id).toBe(before.id);
    expect(restored.range).toEqual(zoomed.range);
    expect(restored.axes).toEqual(zoomed.axes);
    expect(restored.height).toBe(before.height);
    expect(restored.savedHeight).toBe(before.savedHeight);
    expect(restored.slider).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.style.overflow),
    ).toBe("");
    expect(
      await page.evaluate(() =>
        (window as any).fullscreenFixture.calls.filter((call: any) =>
          /set_sampling|set_recording|set_chart_fullscreen/.test(call.command),
        ),
      ),
    ).toEqual([]);
  }
});

test.describe("mobile chart fullscreen", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36",
  });

  test("Android requests immersive landscape and releases it on Back and unmount", async ({
    page,
  }) => {
    await fixture(page);
    const before = await chartState(page, true);
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    const nativeChanges = () =>
      page.evaluate(() =>
        (window as any).fullscreenFixture.calls
          .filter((call: any) => call.command === "set_chart_fullscreen")
          .map((call: any) => call.args.enabled),
      );
    await expect.poll(nativeChanges).toEqual([true]);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator("dialog:modal")).not.toHaveClass(/rotated/);
    await expectScaledFullscreen(page, 844, 390);
    expect((await chartState(page)).id).toBe(before.id);
    expect((await chartState(page)).range).toEqual(before.range);
    await screenshot(page, "android-landscape-emulated");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("atorch-chart-fullscreen-exit")),
    );
    await expect.poll(nativeChanges).toEqual([true, false]);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect.poll(nativeChanges).toEqual([true, false, true]);
    // A route change can unmount the chart while native rotation is pending.
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>(".nav-item")]
        .find((button) => button.textContent === "应用设置")!
        .click(),
    );
    await expect.poll(nativeChanges).toEqual([true, false, true, false]);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.style.overflow),
    ).toBe("");
    expect(
      await page.evaluate(() =>
        (window as any).fullscreenFixture.calls.filter((call: any) =>
          /set_sampling|set_recording/.test(call.command),
        ),
      ),
    ).toEqual([]);
  });

  test("portrait browsers retain a landscape chart when fullscreen locking is unavailable", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      document.documentElement.requestFullscreen = async () => {
        throw new Error("Fullscreen unavailable");
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect(page.locator("dialog:modal")).toHaveClass(
      /chart-fullscreen-rotated/,
    );
    await expectScaledFullscreen(page, 390, 844, true);
    await screenshot(page, "mobile-landscape-fallback");
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "全屏", exact: true }),
    ).toBeVisible();
  });
});
