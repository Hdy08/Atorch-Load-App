import { expect, test } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("charge CSV uses DateTime for real time, preserves relative time, and exports the selected range", async ({
  page,
}) => {
  const path = process.env.ATORCH_REVIEW_CSV;
  const folder = process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/record-review";
  const bytes = path
    ? await readFile(path)
    : Buffer.from(
        'SUM,4\nDateTime,2026-10-02 17:25:37\n\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n="00:00:00.000",0,0,0,\n="00:00:00.100",5.233,-0.0024,0.0124,\n="00:00:00.200",5,-1,5,\n="00:00:00.300",8.9384,-0.0247,0.2209,',
      );
  const count = path ? 43_467 : 4;
  const duration = (count - 1) * 100;
  const start = new Date(2026, 9, 2, 17, 25, 37).getTime();
  await page.addInitScript(() => {
    Object.assign(window, {
      isTauri: true,
      csvTimeSave: "",
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: any) => {
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
          if (command === "list_recordings") return [];
          throw new Error(`Unexpected CSV time command: ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
    name: path ? "NubiaZ70Ultra_20261002_184206.csv" : "charge.csv",
    mimeType: "text/csv",
    buffer: bytes,
  });
  await expect(
    page.getByText(
      `${count.toLocaleString()} / ${count.toLocaleString()} 个采样点`,
      { exact: false },
    ),
  ).toBeVisible();
  for (const name of ["电量 (Wh)", "容量 (mAh)"])
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
        const option = chart.getOption();
        const voltage = option.series.find(
          (series: any) => series.id === "voltage",
        );
        const current = option.series.find(
          (series: any) => series.id === "current",
        );
        return {
          type: option.xAxis[0].type,
          points: voltage.data.length,
          first: voltage.data[0][0],
          last: voltage.data.at(-1)[0],
          voltage: voltage.data.at(-1)[1],
          current: current.data.at(-1)[1],
          energy: option.series
            .find((s: any) => s.id === "energy")
            ?.data.at(-1)[1],
          capacity: option.series
            .find((s: any) => s.id === "capacity")
            ?.data.at(-1)[1],
          range: {
            start: option.dataZoom[0].startValue,
            end: option.dataZoom[0].endValue,
          },
        };
      },
      { applyZoom },
    );
  await expect.poll(async () => (await inspect()).points).toBe(count);
  const clock = await inspect();
  expect(clock).toMatchObject({
    type: "time",
    first: start,
    last: start + duration,
    voltage: 8.9384,
    current: -0.0247,
  });
  expect(clock.energy).toBeGreaterThan(0);
  expect(clock.capacity).toBeGreaterThan(0);
  await expect(
    page.getByRole("tab", { name: "历史记录", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "本机记录库", exact: true }),
  ).toBeVisible();
  await mkdir(folder, { recursive: true });
  await page
    .locator(".review-card")
    .screenshot({ path: `${folder}/csv-real-time.png` });
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  await expect.poll(async () => (await inspect()).type).toBe("value");
  const elapsed = await inspect();
  expect(elapsed).toMatchObject({ first: 0, last: duration, points: count });
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
  const firstElapsed = Math.ceil(range.start / 100) * 100;
  const lastElapsed = Math.floor(range.end / 100) * 100;
  expect(lines).toHaveLength((lastElapsed - firstElapsed) / 100 + 1);
  expect(Date.parse(lines[0].split(",")[0])).toBe(start + firstElapsed);
  expect(Date.parse(lines.at(-1)!.split(",")[0])).toBe(start + lastElapsed);
  expect(Number(lines[0].split(",")[5])).toBeGreaterThan(0);
  expect(Number(lines[0].split(",")[6])).toBeGreaterThan(0);
  const report = {
    source: path ?? "synthetic format fixture",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rows: count,
    origin: "2026-10-02 17:25:37",
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
