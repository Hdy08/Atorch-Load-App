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

test("large CSV renders pixel extrema, loads visible detail, preserves raw hover/export and keeps pan gestures", async ({
  page,
}) => {
  test.setTimeout(90_000);
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
          invoke: async (command: string, args: any) => {
            if (command === "open_csv") {
              perf.start = performance.now();
              return {
                path: "fixture/large.csv",
                name: "large.csv",
                dataBase64: base64,
              };
            }
            if (command === "register_recording") {
              if (!perf.parsed) perf.parsed = performance.now();
              return {};
            }
            if (command === "save_csv") {
              (window as any).csvLodExport = args.content;
              return "fixture/export.csv";
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
      let exact = true;
      for (const channel of series) {
        const data = channel.getData();
        for (let i = 0; i < data.count(); i++) {
          const raw = data.getRawDataItem(i);
          const index = raw[2];
          exact &&=
            raw[0] === origin + index * 100 &&
            raw[1] ===
              (channel.id === "voltage"
                ? 5 + (index % 777) / 1000
                : -(index % 31) / 100);
        }
      }
      return {
        ...perf,
        importMs: perf.parsed - perf.start,
        exact,
        rendered: v.count(),
        sourceCount: count,
        plotWidth: chart
          .getModel()
          .getComponent("grid")
          .coordinateSystem.getRect().width,
      };
    },
    { count, origin },
  );
  expect(report.workers).toBe(1);
  expect(report.terminated).toBe(1);
  expect(report.ticks).toBeGreaterThan(5);
  expect(report.longestTask).toBeLessThan(350);
  expect(report.exact).toBe(true);
  expect(report.rendered).toBeLessThanOrEqual(
    Math.ceil(report.plotWidth) * 2 + 2,
  );
  await expect(page.locator(".trend-chart")).toHaveAttribute(
    "data-render-mode",
    "viewport",
  );
  // Export proves every original row survives the display reduction.
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const exported = await page.evaluate(
    () => (window as any).csvLodExport as string,
  );
  const raw = exported.trim().split(/\r?\n/).slice(1);
  expect(raw).toHaveLength(count);
  for (let i = 0; i < count; i++) {
    const cells = raw[i].split(",");
    if (
      Date.parse(cells[0]) !== origin + i * 100 ||
      Number(cells[1]) !== 5 + (i % 777) / 1000 ||
      Number(cells[2]) !== -(i % 31) / 100
    )
      throw new Error(`Export changed original sample ${i}`);
  }
  for (const key of ["功率", "电量", "容量", "CPU 温度"])
    await page.getByRole("checkbox", { name: key, exact: true }).check();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    const power = chart
      .getModel()
      .getSeries()
      .find((s: any) => s.id === "power");
    const data = power.getData();
    let peak = -1;
    for (let i = 0; i < data.count(); i++)
      if (data.getRawDataItem(i)[2] === 123456) peak = i;
    if (peak < 0) throw new Error("Pixel sampling dropped the 400 W peak");
    chart.dispatchAction({
      type: "showTip",
      seriesIndex: power.seriesIndex,
      dataIndex: peak,
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
  await expect(page.locator('[data-measurement="voltage"] strong')).toHaveText(
    /^\d+\.\d{1,20}$/,
  );
  await expect(page.locator('[data-measurement="current"] strong')).toHaveText(
    /^-?\d+\.\d{2}$/,
  );
  // Hover an original current reading omitted from that channel's points.
  const hoverPosition = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const element = document.querySelector(".trend-chart")!;
    const chart = getInstanceByDom(element);
    const grid = chart
      .getModel()
      .getComponent("grid")
      .coordinateSystem.getRect();
    const box = element.getBoundingClientRect();
    chart.getZr().on("mousemove", (event: any) => {
      const time = chart.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
      const index = Math.round(
        (time - Date.parse("2026-11-14T00:00:00Z")) / 100,
      );
      const data = chart
        .getModel()
        .getSeries()
        .find((s: any) => s.id === "current")
        .getData();
      let rendered = false;
      for (let i = 0; i < data.count(); i++)
        rendered ||= data.getRawDataItem(i)[2] === index;
      (window as any).csvLodHover = { index, rendered };
    });
    const prototype = Object.getPrototypeOf(chart);
    const original = prototype.setOption;
    (window as any).chartLodUpdates = [];
    prototype.setOption = function (...args: any[]) {
      const start = performance.now();
      const result = original.apply(this, args);
      if (!args[1]?.notMerge)
        (window as any).chartLodUpdates.push(performance.now() - start);
      return result;
    };
    return { x: box.x + grid.x + grid.width * 0.373, y: box.y + grid.y + 80 };
  });
  await page.mouse.move(hoverPosition.x, hoverPosition.y);
  const hovered = await page.evaluate(() => (window as any).csvLodHover);
  expect(hovered.rendered).toBe(false);
  const expectedValues = {
    voltage: 5 + (hovered.index % 777) / 1000,
    current: -(hovered.index % 31) / 100,
    power: hovered.index === 123456 ? 400 : 5,
    energy: hovered.index / 123456789,
    capacity: hovered.index / 1000,
    cpuTemperature: hovered.index % 100,
  };
  for (const [key, value] of Object.entries(expectedValues))
    await expect
      .poll(async () =>
        Number(
          await page
            .locator(`[data-measurement="${key}"] strong`)
            .textContent(),
        ),
      )
      .toBeCloseTo(value, 12);
  await page.mouse.move(0, 0);
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
  const inspect = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const element = document.querySelector(".trend-chart")!;
      const chart = getInstanceByDom(element),
        model = chart.getModel();
      const data = model.getSeriesByIndex(0).getData();
      const range = model.getComponent("dataZoom").getValueRange("x", 0);
      const grid = model.getComponent("grid").coordinateSystem.getRect();
      const box = element.getBoundingClientRect();
      return {
        start: range[0],
        end: range[1],
        left: box.x,
        top: box.y,
        width: chart.getWidth(),
        height: chart.getHeight(),
        grid: { x: grid.x, width: grid.width },
        points: Array.from(
          { length: data.count() },
          (_, i) => data.getRawDataItem(i) as number[],
        ),
      };
    });
  await expect
    .poll(
      async () =>
        (await inspect()).points.filter(
          (p) => p[0] >= 12_345_600 && p[0] <= 12_346_000,
        ).length,
    )
    .toBe(5);
  const coreZoom = async (start: number, end: number) =>
    page.evaluate(
      async ({ start, end }) => {
        const url = performance
          .getEntriesByType("resource")
          .map((e) => e.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction(
          { type: "dataZoom", start, end },
        );
      },
      { start, end },
    );
  await coreZoom(30, 70);
  const beforeWheel = await inspect();
  await page.evaluate(
    ({ x, y }) => {
      const element = document.querySelector(".trend-chart")!;
      for (let i = 0; i < 7; i++)
        element.dispatchEvent(
          new WheelEvent("wheel", {
            clientX: x,
            clientY: y,
            deltaY: -100,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    {
      x: beforeWheel.left + beforeWheel.grid.x + beforeWheel.grid.width / 2,
      y: beforeWheel.top + beforeWheel.height - 40,
    },
  );
  const afterWheel = await inspect();
  expect(
    (afterWheel.end - afterWheel.start) / (beforeWheel.end - beforeWheel.start),
  ).toBeCloseTo(Math.exp(-0.2 * 7), 6);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction({
      type: "dataZoom",
      start: 20,
      end: 60,
    });
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "重置缩放")!
      .click();
  });
  await expect(
    page.getByText(
      `${count.toLocaleString()} / ${count.toLocaleString()} 个采样点`,
      { exact: false },
    ),
  ).toBeVisible();
  await page.waitForTimeout(160);
  const reset = await inspect();
  expect(reset.start).toBe(0);
  expect(reset.end).toBe((count - 1) * 100);
  expect(reset.points[0][2]).toBe(0);
  for (const target of ["plot", "slider"]) {
    await coreZoom(30, 70);
    await page.waitForTimeout(180);
    const start = await inspect();
    const x = start.left + start.grid.x + start.grid.width / 2;
    const y = start.top + (target === "plot" ? 100 : start.height - 9);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 35, y, { steps: 5 });
    await page.waitForTimeout(150);
    const middle = await inspect();
    expect(middle.points[0][2]).not.toBe(start.points[0][2]);
    await page.mouse.move(x + 85, y, { steps: 8 });
    await page.waitForTimeout(150);
    const last = await inspect();
    expect(
      (last.start - middle.start) * (target === "plot" ? -1 : 1),
    ).toBeGreaterThan(0);
    await page.mouse.up();
    expect(last.points.length).toBeLessThanOrEqual(
      Math.ceil(last.grid.width) * 2 + 4,
    );
  }
  // Export reads the current zoom immediately, before the delayed statistics.
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
    (window as any).csvLodExport = "";
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "导出 CSV")!
      .click();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).csvLodExport.split(/\r?\n/).filter(Boolean).length,
      ),
    )
    .toBe(6);
  const updateTimes = await page.evaluate(
    () => (window as any).chartLodUpdates as number[],
  );
  expect(updateTimes.length).toBeGreaterThan(5);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await expect
    .poll(async () => (await inspect()).points.length)
    .toBeLessThanOrEqual(390 * 2 + 4);
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await mkdir("artifacts/chart-lod", { recursive: true });
  await writeFile(
    "artifacts/chart-lod/ui-performance.json",
    JSON.stringify(
      {
        ...report,
        hoveredOriginalIndex: hovered.index,
        updates: updateTimes.length,
        maxUpdateMs: Math.max(...updateTimes),
        medianUpdateMs: updateTimes.sort((a, b) => a - b)[
          Math.floor(updateTimes.length / 2)
        ],
      },
      null,
      2,
    ),
  );
});
