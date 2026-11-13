import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

test("CSV worker accepts browser files and terminates after a parse failure", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).fileWorkers = { created: 0, terminated: 0 };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).fileWorkers.created++;
      }
      terminate() {
        (window as any).fileWorkers.terminated++;
        super.terminate();
      }
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { importCsv } = await import("/src/lib/csvImport.ts");
    const text =
      "DATE,VOLTAGE(V),CURRENT(A),POWER(W)\n2026-11-14T00:00:00Z,5,-1,5\n2026-11-14T00:00:01Z,5,-1,5";
    const rows = await importCsv({
      file: new File([text], "browser.csv", { type: "text/csv" }),
    });
    let error = "";
    try {
      await importCsv({ file: new File(["invalid"], "invalid.csv") });
    } catch (failure) {
      error = (failure as Error).message;
    }
    return { rows, error, workers: (window as any).fileWorkers };
  });
  expect(result.rows).toHaveLength(2);
  expect(result.rows[1]).toMatchObject({
    voltage: 5,
    current: -1,
    power: 5,
    energyCalculated: true,
    capacityCalculated: true,
  });
  expect(result.rows[1].energy).toBeCloseTo(5 / 3600, 12);
  expect(result.error).toContain("未找到 DATE 或 Time 表头");
  expect(result.workers).toEqual({ created: 2, terminated: 2 });
});

test("large CSV imports off the UI thread, retains every point and shares full-resolution chart data", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const count = 250_003;
  const origin = Date.parse("2026-11-14T00:00:00Z");
  const csv =
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh),E_CAPACITY(mAh),CPU_TEMP(℃)\n" +
    Array.from(
      { length: count },
      (_, i) =>
        `${new Date(origin + i * 100).toISOString()},${5 + (i % 777) / 1000},${-(i % 31) / 100},${i === 123456 ? 400 : 5},${i / 123456789},${i / 1000},${i % 100}`,
    ).join("\n");
  await page.addInitScript(
    ({ base64 }) => {
      const nativeWorker = window.Worker;
      const perf = {
        start: 0,
        parsed: 0,
        workers: 0,
        terminated: 0,
        ticks: 0,
        longestTask: 0,
      };
      (window as any).csvPerformance = perf;
      window.Worker = class extends nativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          perf.workers++;
        }
        terminate() {
          perf.terminated++;
          super.terminate();
        }
      };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (perf.start && entry.startTime >= perf.start)
            perf.longestTask = Math.max(perf.longestTask, entry.duration);
      }).observe({ type: "longtask", buffered: true });
      setInterval(() => {
        if (perf.start && !perf.parsed) perf.ticks++;
      }, 16);
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            if (command === "open_csv") {
              perf.start = performance.now();
              return {
                path: "fixture/large.csv",
                name: "large.csv",
                dataBase64: base64,
              };
            }
            if (command === "register_recording") {
              perf.parsed = performance.now();
              return {};
            }
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
            if (command === "list_recordings" || command === "discover_devices")
              return [];
            if (command === "get_bluetooth_status")
              return {
                supported: false,
                enabled: false,
                permission: false,
                locationRequired: false,
                locationEnabled: false,
              };
            throw new Error(command);
          },
        },
      });
    },
    { base64: Buffer.from(csv).toString("base64") },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  // Navigation can respond while the worker parses and prepares the full file.
  await expect
    .poll(() => page.evaluate(() => (window as any).csvPerformance.workers))
    .toBe(1);
  await page
    .getByRole("button", { name: "应用设置", exact: true })
    .click({ timeout: 1500 });
  await expect(
    page.getByRole("tab", { name: "外观", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(
    page.getByText(
      `${count.toLocaleString()} / ${count.toLocaleString()} 个采样点`,
      { exact: false },
    ),
  ).toBeVisible({ timeout: 30_000 });
  const report = await page.evaluate(
    async ({ count, origin }) => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const perf = { ...(window as any).csvPerformance };
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      const series = chart.getModel().getSeries();
      const v = series.find((s: any) => s.id === "voltage").getData();
      const a = series.find((s: any) => s.id === "current").getData();
      const x = v.mapDimension("x"),
        y = v.mapDimension("y"),
        current = a.mapDimension("y");
      let complete = v.count() === count && a.count() === count;
      for (let i = 0; i < count && complete; i++)
        complete =
          v.get(x, i) === origin + i * 100 &&
          v.get(y, i) === 5 + (i % 777) / 1000 &&
          a.get(current, i) === -(i % 31) / 100;
      return {
        ...perf,
        importMs: perf.parsed - perf.start,
        complete,
        count: v.count(),
        sharedStore: v.getStore() === a.getStore(),
      };
    },
    { count, origin },
  );
  expect(report.workers).toBe(1);
  expect(report.terminated).toBe(1);
  expect(report.ticks).toBeGreaterThan(5);
  expect(report.longestTask).toBeLessThan(1000);
  expect(report.complete).toBe(true);
  expect(report.sharedStore).toBe(true);
  for (const key of ["功率 (W)", "电量 (Wh)", "容量 (mAh)", "CPU 温度 (°C)"])
    await page.getByRole("checkbox", { name: key, exact: true }).check();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    chart.dispatchAction({
      type: "showTip",
      seriesIndex: 0,
      dataIndex: 123456,
    });
  });
  await expect(page.locator(".curve-tooltip")).toContainText("400");
  for (const label of [
    "电压 (V)",
    "电流 (A)",
    "功率 (W)",
    "电量 (Wh)",
    "容量 (mAh)",
    "CPU 温度 (°C)",
  ])
    await expect(page.locator(".curve-tooltip")).toContainText(label);
  expect(await page.locator(".curve-tooltip").innerText()).not.toMatch(
    /\d+\.\d{5,}/,
  );
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction({
      type: "dataZoom",
      startValue: 12_345_600,
      endValue: 12_346_000,
    });
  });
  await expect(
    page.getByText(`5 / ${count.toLocaleString()} 个采样点`, { exact: false }),
  ).toBeVisible();
  const power = page
    .getByRole("table", { name: "采样统计" })
    .getByRole("row")
    .filter({ hasText: "功率 / W" });
  await expect(power.getByRole("cell").nth(3)).toHaveText("400");
  await mkdir("artifacts/large-csv", { recursive: true });
  await writeFile(
    "artifacts/large-csv/ui-performance.json",
    JSON.stringify(report, null, 2),
  );
});
