import { expect, test } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";

test("charge CSV uses DateTime for real time, preserves relative time, and exports the selected range", async ({
  page,
}) => {
  const path = process.env.ATORCH_REVIEW_CSV;
  test.setTimeout(path ? 90_000 : 30_000);
  const folder = process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/record-review";
  const bytes = path
    ? await readFile(path)
    : Buffer.from(
        'SUM,4\nDateTime,2026-10-02 17:25:37\n\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n="00:00:00.000",0,0,0,\n="00:00:00.100",5.233,-0.0024,0.0124,\n="00:00:00.200",5,-1,5,\n="00:00:00.300",8.9384,-0.0247,0.2209,',
      );
  const source = bytes.toString("utf8").trim().split(/\r?\n/);
  const rawRows = source
    .slice(source.findIndex((line) => line.startsWith("Time(")) + 1)
    .filter(Boolean);
  const count = path ? Number(/^SUM,(\d+)/.exec(source[0])![1]) : 4;
  expect(rawRows).toHaveLength(count);
  const last = rawRows.at(-1)!.split(",");
  const durationOf = (text: string) => {
    const match = /(?:(\d+)\.)?(\d+):([0-5]\d):([0-5]\d)\.(\d{3})/.exec(text)!;
    return (
      ((Number(match[1] ?? 0) * 24 + Number(match[2])) * 3600 +
        Number(match[3]) * 60 +
        Number(match[4])) *
        1000 +
      Number(match[5])
    );
  };
  const duration = durationOf(last[0]);
  const origin = source.find((line) => line.startsWith("DateTime,"))!.slice(9);
  const start = new Date(origin.replace(" ", "T")).getTime();
  await page.addInitScript(
    ({ encoded, name }) => {
      const document = {
        path: `fixture/${name}`,
        name,
        bytes: 1,
        modifiedAt: Date.now(),
        dataBase64: encoded,
      };
      let imported = false;
      Object.assign(window, {
        isTauri: true,
        csvTimeSave: "",
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "open_csv") return document;
            if (command === "register_recording") {
              imported = true;
              return { ...document, id: document.path };
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
            if (command === "save_csv") {
              (window as any).csvTimeSave = args.content;
              return "fixture/selected.csv";
            }
            if (command === "list_recordings")
              return imported ? [{ ...document, id: document.path }] : [];
            throw new Error(`Unexpected CSV time command: ${command}`);
          },
        },
      });
    },
    {
      encoded: bytes.toString("base64"),
      name: path ? basename(path) : "charge.csv",
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  await expect(
    page.getByText(
      `${count.toLocaleString()} / ${count.toLocaleString()} 个采样点`,
      { exact: false },
    ),
  ).toBeVisible();
  for (const name of ["功率 (W)", "电量 (Wh)", "容量 (mAh)"])
    await page.getByRole("checkbox", { name, exact: true }).check();
  for (const name of ["电量 / Wh", "容量 / mAh"]) {
    const stats = page
      .getByRole("table", { name: "采样统计" })
      .getByRole("row")
      .filter({ hasText: name });
    await expect(stats.getByRole("cell").first()).toContainText("计算");
    await expect(stats.getByRole("cell").last()).toHaveText("—");
  }
  const inspect = (applyZoom = false) =>
    page.evaluate(
      async ({ applyZoom }) => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        const chart = getInstanceByDom(document.querySelector(".trend-chart"));
        if (applyZoom)
          chart.dispatchAction({ type: "dataZoom", start: 20, end: 40 });
        const model = chart.getModel();
        const data = (key: string) =>
          model
            .getSeries()
            .find((series: any) => series.id === key)
            .getData();
        const at = (key: string, axis: string, index: number) => {
          const series = data(key);
          return series.get(series.mapDimension(axis), index);
        };
        const lastIndex = data("voltage").count() - 1;
        const lastValue = (key: string) => at(key, "y", data(key).count() - 1);
        const range = model.getComponent("dataZoom").getValueRange("x", 0);
        return {
          processed: chart
            .getModel()
            .getSeries()
            .map((series: any) => ({
              id: series.id,
              count: series.getData().count(),
              aligned: Array.from(
                { length: series.getData().count() },
                (_, i) => series.getData().getRawIndex(i) === i,
              ).every(Boolean),
            })),
          type: model.getComponent("xAxis").get("type"),
          plotWidth: model.getComponent("grid").coordinateSystem.getRect()
            .width,
          mode: document
            .querySelector(".trend-chart")!
            .getAttribute("data-render-mode"),
          sourceCount: Number(
            document
              .querySelector(".trend-chart")!
              .getAttribute("data-source-count"),
          ),
          points: lastIndex + 1,
          first: at("voltage", "x", 0),
          last: at("voltage", "x", lastIndex),
          voltage: lastValue("voltage"),
          current: lastValue("current"),
          energy: lastValue("energy"),
          capacity: lastValue("capacity"),
          range: {
            start: range[0],
            end: range[1],
          },
        };
      },
      { applyZoom },
    );
  await expect.poll(async () => (await inspect()).sourceCount).toBe(count);
  const clock = await inspect();
  for (const series of clock.processed) {
    if (clock.mode === "viewport")
      expect(
        series.count,
        `${series.id} respects the pixel budget`,
      ).toBeLessThanOrEqual(Math.ceil(clock.plotWidth) * 2 + 2);
    else expect(series.count).toBe(count);
    expect(series.aligned).toBe(true);
  }
  // At full-file scale every channel must report the very same source row.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    const count = chart.getModel().getSeriesByIndex(0).getData().count();
    chart.dispatchAction({
      type: "showTip",
      seriesIndex: 0,
      dataIndex: Math.floor(count * 0.6),
    });
  });
  const tooltip = page.locator(".curve-tooltip");
  await expect(tooltip).toBeVisible();
  for (const label of [
    "电压 (V)",
    "电流 (A)",
    "功率 (W)",
    "电量 (Wh)",
    "容量 (mAh)",
  ])
    await expect(tooltip).toContainText(label);
  expect(await tooltip.innerText()).not.toMatch(/\d+\.\d{5,}/);
  expect(clock).toMatchObject({
    type: "time",
    first: start,
    last: start + duration,
    voltage: Number(last[1]),
    current: Number(last[2]),
  });
  expect(clock.energy).toBeGreaterThan(0);
  expect(clock.capacity).toBeGreaterThan(0);
  await expect(
    page.getByRole("tab", { name: "历史记录", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "本机记录库", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await mkdir(folder, { recursive: true });
  await page
    .locator(".review-card")
    .screenshot({ path: `${folder}/csv-real-time.png` });
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  await expect.poll(async () => (await inspect()).type).toBe("value");
  const elapsed = await inspect();
  expect(elapsed).toMatchObject({
    first: 0,
    last: duration,
    sourceCount: count,
  });
  await page
    .locator(".review-card")
    .screenshot({ path: `${folder}/csv-relative-time.png` });
  const { range } = await inspect(true);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).csvTimeSave.length))
    .toBeGreaterThan(0);
  const csv = await page.evaluate(() => (window as any).csvTimeSave as string);
  const lines = csv.trim().split(/\r?\n/).slice(1);
  const expectedRows = rawRows.filter((line) => {
    const time = durationOf(line.split(",")[0]);
    return time >= range.start && time <= range.end;
  });
  const firstElapsed = durationOf(expectedRows[0].split(",")[0]);
  const lastElapsed = durationOf(expectedRows.at(-1)!.split(",")[0]);
  expect(lines).toHaveLength(expectedRows.length);
  for (const [index, line] of lines.entries()) {
    const expected = expectedRows[index].split(",");
    const actual = line.split(",");
    if (
      Date.parse(actual[0]) !== start + durationOf(expected[0]) ||
      [1, 2, 3].some(
        (column) =>
          (Number(actual[column]) || 0) !== (Number(expected[column]) || 0),
      )
    )
      throw new Error(`导出第 ${index + 1} 个采样点与原始 CSV 不一致`);
  }
  expect(Date.parse(lines[0].split(",")[0])).toBe(start + firstElapsed);
  expect(Date.parse(lines.at(-1)!.split(",")[0])).toBe(start + lastElapsed);
  expect(Number(lines[0].split(",")[5])).toBeGreaterThan(0);
  expect(Number(lines[0].split(",")[6])).toBeGreaterThan(0);
  const report = {
    source: path ?? "synthetic format fixture",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rows: count,
    origin,
    durationMs: duration,
    clock,
    elapsed,
    exportedRows: lines.length,
    exportedFirstTimestamp: lines[0].split(",")[0],
    exportedLastTimestamp: lines.at(-1)!.split(",")[0],
  };
  await writeFile(
    `${folder}/charge-csv-report.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
});
