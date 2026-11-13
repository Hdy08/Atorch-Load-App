import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

async function fixture(page: Page, bluetooth = false) {
  await page.addInitScript(
    ({ bluetooth }) => {
      const state = {
        hz: Number(localStorage.getItem("fixture-native-rate") ?? 1),
        failRate: false,
        calls: [] as { command: string; time: number }[],
        renders: [] as number[],
        count: 0,
        lastTick: performance.now(),
        rows: [] as any[],
      };
      Object.assign(window, {
        isTauri: true,
        rateFixture: state,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            state.calls.push({ command, time: performance.now() });
            if (command === "set_usb_sample_rate") {
              if (state.failRate) throw new Error("采样率设置失败");
              state.hz = args.hz;
              localStorage.setItem("fixture-native-rate", String(args.hz));
              state.lastTick = performance.now();
              return;
            }
            if (command === "get_snapshot") {
              const now = performance.now(),
                interval = 1000 / (bluetooth ? 1 : state.hz);
              while (
                now - state.lastTick >= interval ||
                state.rows.length === 0
              ) {
                state.lastTick += interval;
                const index = state.count++;
                state.rows.push({
                  timestamp: 1794535200000 + index * interval,
                  voltage: 12 + Math.sin(index / 10),
                  current: 1,
                  power: 12,
                  energy: 1,
                  capacity: 1,
                  resistance: 12,
                  cpuTemperature: 25,
                  ntcTemperature: 25,
                  mosTemperature: 25,
                  fanSpeed: 0,
                  running: false,
                  status: 0,
                });
              }
              return {
                connected: true,
                device: {
                  path: "fixture",
                  name: "BW150 · 频率测试数据",
                  serial: "UI fixture",
                  vendorId: 0x0483,
                  productId: 0x5750,
                  transport: bluetooth ? "bluetooth" : "usb",
                },
                telemetry: state.rows.at(-1),
                settings: null,
                sampleCount: state.count,
                samplingPaused: false,
                usbSampleRateHz: state.hz,
                connectedAt: 1794535200000,
                lastReportAt: Date.now(),
                recording: null,
                error: null,
                logs: [],
              };
            }
            if (command === "get_history") {
              // Realistic IPC cost exposes a timer that incorrectly adds another
              // full interval after each request and therefore refreshes too slowly.
              await new Promise((resolve) => setTimeout(resolve, 20));
              return [...state.rows];
            }
            throw new Error(`Unexpected rate test command: ${command}`);
          },
        },
      });
    },
    { bluetooth },
  );
  await page.goto("/");
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
}

for (const hz of [1, 2, 5, 10]) {
  test(`USB ${hz} Hz selection synchronizes IPC and actual chart rendering`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByLabel("USB 采样率").selectOption(String(hz));
    await expect(page.getByLabel("USB 采样率")).toHaveValue(String(hz));
    await page.waitForTimeout(650);
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      const state = (window as any).rateFixture;
      state.calls = [];
      state.renders = [];
      chart.on("finished", () => state.renders.push(performance.now()));
    });
    await page.waitForTimeout(2600);
    const result = await page.evaluate(async () => {
      const state = (window as any).rateFixture;
      const meanGap = (times: number[]) =>
        (times.at(-1)! - times[0]) / (times.length - 1);
      const polls = state.calls
        .filter((call: any) => call.command === "get_history")
        .map((call: any) => call.time);
      const url = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      return {
        hz: state.hz,
        polls: polls.length,
        renders: state.renders.length,
        pollGapMs: meanGap(polls),
        renderGapMs: meanGap(state.renders),
        plotPoints: chart.getOption().series[0].data.length,
        collectedPoints: state.rows.length,
        commands: [...new Set(state.calls.map((call: any) => call.command))],
      };
    });
    const period = 1000 / hz;
    expect(result.pollGapMs).toBeGreaterThan(period * 0.8);
    expect(result.pollGapMs).toBeLessThan(period * 1.2);
    expect(result.renderGapMs).toBeGreaterThan(period * 0.8);
    expect(result.renderGapMs).toBeLessThan(period * 1.2);
    expect(Math.abs(result.renders - result.polls)).toBeLessThanOrEqual(1);
    expect(result.collectedPoints - result.plotPoints).toBeLessThanOrEqual(1);
    expect(
      result.commands.every((command) =>
        ["get_snapshot", "get_history"].includes(command as string),
      ),
    ).toBe(true);
    await mkdir("artifacts/usb-rates", { recursive: true });
    await writeFile(
      `artifacts/usb-rates/ui-${hz}hz.json`,
      JSON.stringify(result, null, 2),
    );
  });
}

test("rate failures preserve the confirmed rate and BLE exposes no rate write", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).rateFixture.failRate = true;
  });
  await page.getByLabel("USB 采样率").selectOption("10");
  await expect(
    page.getByText("Error: 采样率设置失败", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("USB 采样率")).toHaveValue("1");
  expect(
    await page.evaluate(() => localStorage.getItem("fixture-native-rate")),
  ).toBeNull();
});

test("sample rate defaults to 1 Hz and reflects the saved native preference on restart", async ({
  page,
}) => {
  await fixture(page);
  const select = page.getByLabel("USB 采样率");
  await expect(select).toHaveValue("1");
  await expect(select.locator("option")).toHaveText([
    "1 Hz 采样",
    "2 Hz 采样",
    "5 Hz 采样",
    "10 Hz 采样",
  ]);
  await select.selectOption("5");
  await expect(select).toHaveValue("5");
  await page.reload();
  await expect(page.getByLabel("USB 采样率")).toHaveValue("5");
});

test("BLE retains its device cadence without USB rate controls", async ({
  page,
}) => {
  await fixture(page, true);
  await expect(page.getByLabel("USB 采样率")).toHaveCount(0);
  await page.waitForTimeout(2200);
  const gaps = await page.evaluate(() => {
    const calls = (window as any).rateFixture.calls.filter(
      (call: any) => call.command === "get_history",
    );
    return calls
      .slice(1)
      .map((call: any, index: number) => call.time - calls[index].time);
  });
  expect(gaps.length).toBeGreaterThanOrEqual(2);
  expect(gaps.every((gap: number) => gap > 800 && gap < 1200)).toBe(true);
});
