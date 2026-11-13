import { expect, test, type Page } from "@playwright/test";

async function openCurveSettings(page: Page) {
  await page.getByRole("button", { name: "应用设置", exact: true }).click();
  await page.getByRole("tab", { name: "曲线", exact: true }).click();
}

async function fixture(page: Page, count = 4) {
  await page.addInitScript(
    ({ count }) => {
      const base = new Date(2026, 10, 12, 10).getTime();
      const rows = Array.from({ length: count }, (_, index) => ({
        timestamp: base + index * 1000,
        voltage: (index + 1) * 10,
        current: index - 1,
        power: (index + 1) * 10 * (index - 1),
        energy: null,
        capacity: 6620,
        resistance: null,
        cpuTemperature: null,
        ntcTemperature: null,
        mosTemperature: 26,
        fanSpeed: null,
        running: null,
        status: 0,
      }));
      const archive =
        "DATE,VOLTAGE(V),CURRENT(A)\n" +
        Array.from(
          { length: 8001 },
          (_, i) => `${new Date(base + i * 1000).toISOString()},12,1`,
        ).join("\n");
      const calls: { command: string; args?: unknown }[] = [];
      Object.assign(window, {
        isTauri: true,
        reviewCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args?: unknown) => {
            calls.push({ command, args });
            if (command === "get_snapshot")
              return {
                connected: true,
                device: {
                  path: "fixture",
                  name: "BW150",
                  serial: "fixture",
                  vendorId: 0x0483,
                  productId: 0x5750,
                },
                telemetry: rows.at(-1),
                settings: null,
                sampleCount: rows.length,
                connectedAt: base,
                lastReportAt: Date.now(),
                recording: null,
                error: null,
                logs: [],
              };
            if (command === "get_history") return [...rows];
            if (command === "list_recordings")
              return [
                {
                  id: "fixture/imported.csv",
                  path: "fixture/imported.csv",
                  name: "BW150_imported.csv",
                  bytes: 1000,
                  modifiedAt: base,
                },
                {
                  id: "fixture/complete.csv",
                  path: "fixture/complete.csv",
                  name: "BW150_complete.csv",
                  bytes: archive.length,
                  modifiedAt: base,
                },
              ];
            if (command === "read_recording")
              return {
                name: "BW150_complete.csv",
                path: "fixture/complete.csv",
                dataBase64: btoa(archive),
              };
            if (command === "save_csv") return "fixture/selected.csv";
            if (command === "save_png") return "fixture/chart.png";
            throw new Error(`Unexpected review test command: ${command}`);
          },
        },
      });
    },
    { count },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(
    page.getByText(`${count} / ${count} 个采样点`, { exact: false }),
  ).toBeVisible();
}

test("selected curves and axis order persist across pages, files and reloads", async ({
  page,
}) => {
  await fixture(page);
  const selector = page.getByRole("group", { name: "曲线参数", exact: true });
  const expectSelection = async (keys: string[]) => {
    await expect(page.locator(".trend-chart canvas")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const url = performance
            .getEntriesByType("resource")
            .map((resource) => resource.name)
            .find((url) => url.includes("/echarts_core.js"))!;
          const core = await import(url);
          return core
            .getInstanceByDom(document.querySelector(".trend-chart"))
            ?.getOption()
            .series.map((series: any) => series.id);
        }),
      )
      .toEqual(keys);
    await expect
      .poll(() =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("atorch-chart-selection")!),
        ),
      )
      .toEqual(keys);
    await expect(selector.getByRole("checkbox", { checked: true })).toHaveCount(
      keys.length,
    );
  };

  await expectSelection(["voltage", "current"]);
  for (const name of ["电量 (Wh)", "MOS 温度 (°C)", "容量 (mAh)"])
    await selector.getByRole("checkbox", { name, exact: true }).check();
  for (const name of ["电压 (V)", "电流 (A)"])
    await selector.getByRole("checkbox", { name, exact: true }).uncheck();
  const selected = ["energy", "mosTemperature", "capacity"];
  await expectSelection(selected);
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await expectSelection(selected);
  await page.reload();
  await expectSelection(selected);

  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await page
    .locator(".recording-entry")
    .filter({ hasText: "BW150_complete.csv" })
    .getByRole("button", { name: "打开记录" })
    .click();
  await expectSelection(selected);
  // A file without temperature data must retain the user's chosen channel.
  await expect(
    selector.getByRole("checkbox", { name: "MOS 温度 (°C)", exact: true }),
  ).toBeChecked();
  await selector
    .getByRole("checkbox", { name: "MOS 温度 (°C)", exact: true })
    .uncheck();
  await selector
    .getByRole("checkbox", { name: "功率 (W)", exact: true })
    .check();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  await expectSelection(["energy", "capacity", "power"]);

  // Reject unknown / duplicate keys without changing the saved axis order.
  await page.evaluate(() =>
    localStorage.setItem(
      "atorch-chart-selection",
      JSON.stringify(["capacity", "unknown", "energy", "capacity", null, 8]),
    ),
  );
  await page.reload();
  await expectSelection(["capacity", "energy"]);
  for (const invalid of ["{", "null", "[]", '["unknown"]']) {
    await page.evaluate(
      (value) => localStorage.setItem("atorch-chart-selection", value),
      invalid,
    );
    await page.reload();
    await expectSelection(["voltage", "current"]);
  }
});

test("reference library opens every sample and exposes selectable external files", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    page.getByRole("tablist", { name: "数据记录分类" }).getByRole("tab"),
  ).toHaveCount(2);
  await expect(
    page.getByRole("tab", { name: "当前记录", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "历史记录", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "本机记录库", exact: true }),
  ).toBeVisible();
  const imported = page
    .locator(".recording-entry")
    .filter({ hasText: "BW150_imported.csv" });
  await expect(
    imported.getByRole("button", { name: "打开记录" }),
  ).toBeEnabled();
  await expect(imported.getByRole("checkbox")).not.toBeChecked();
  await page
    .locator(".recording-entry")
    .filter({ hasText: "BW150_complete.csv" })
    .getByRole("button", { name: "打开记录" })
    .click();
  await expect(
    page.getByText("8,001 / 8,001 个采样点", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("第 1 / 81 页")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
  ).toHaveCount(100);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("第 2 / 81 页")).toBeVisible();
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const saved = await page.evaluate(
    () =>
      (window as any).reviewCalls.findLast((c: any) => c.command === "save_csv")
        .args.content as string,
  );
  expect(saved.trim().split(/\r?\n/)).toHaveLength(8002);
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("time range drives chart, statistics, details and exported rows together", async ({
  page,
}) => {
  await fixture(page);
  await page.getByLabel("回看开始时间").fill("2026-11-12T10:00:01");
  await page.getByLabel("回看结束时间").fill("2026-11-12T10:00:02");
  await expect(
    page.getByText("2 / 4 个采样点", { exact: false }),
  ).toBeVisible();
  const voltage = page
    .getByRole("table", { name: "采样统计" })
    .getByRole("row")
    .filter({ hasText: "电压 / V" });
  await expect(voltage.getByRole("cell")).toHaveText([
    "电压 / V",
    "2",
    "20",
    "30",
    "25",
  ]);
  await expect(
    page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const saved = await page.evaluate(
    () =>
      (window as any).reviewCalls.findLast((c: any) => c.command === "save_csv")
        .args.content as string,
  );
  expect(saved.trim().split(/\r?\n/)).toHaveLength(3);
  await expect(
    page.getByRole("checkbox", { name: "电量 (Wh)", exact: true }),
  ).toBeVisible();
  await page.getByLabel("回看开始时间").fill("2026-11-12T10:00:03");
  await expect(page.getByText(/时间范围无效/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "全部时间", exact: true }).click();
  await expect(
    page.getByText("4 / 4 个采样点", { exact: false }),
  ).toBeVisible();
});

test("cumulative channels have no average and calculated totals retain their origin after filtering", async ({
  page,
}) => {
  await fixture(page);
  for (const name of ["电量 (Wh)", "容量 (mAh)"])
    await page.getByRole("checkbox", { name, exact: true }).check();
  const stats = page.getByRole("table", { name: "采样统计" });
  const energy = stats.getByRole("row").filter({ hasText: "电量 / Wh" });
  const capacity = stats.getByRole("row").filter({ hasText: "容量 / mAh" });
  await expect(energy.getByRole("cell").first()).toHaveText("电量 / Wh (计算)");
  await expect(energy.getByRole("cell").last()).toHaveText("—");
  await expect(capacity.getByRole("cell").last()).toHaveText("—");
  await expect(capacity.getByRole("cell").first()).toHaveText("容量 / mAh");
  await page.getByLabel("回看开始时间").fill("2026-11-12T10:00:02");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const saved = await page.evaluate(
    () =>
      (window as any).reviewCalls.findLast((c: any) => c.command === "save_csv")
        .args.content as string,
  );
  const cells = saved.trim().split(/\r?\n/)[1].split(",");
  expect(Number(cells[5])).toBeCloseTo(20 / 3600, 10);
  expect(Number(cells[6])).toBe(6620);
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    const widths = await page
      .getByRole("table", { name: "采样明细" })
      .locator("tbody tr")
      .first()
      .getByRole("cell")
      .evaluateAll((cells) =>
        cells.map((cell) => ({
          width: cell.clientWidth,
          content: cell.scrollWidth,
        })),
      );
    expect(widths.every((cell) => cell.content <= cell.width + 1)).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: `${process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/record-review"}/current-record.png`,
    fullPage: true,
  });
});

test("per-channel coordinate ranges validate and persist independently", async ({
  page,
}) => {
  await fixture(page);
  await openCurveSettings(page);
  await page.getByLabel("电压最小值", { exact: true }).fill("20");
  await page.getByLabel("电压最大值", { exact: true }).fill("1");
  await page.getByRole("button", { name: "应用更改" }).click();
  await expect(page.getByText(/电压的范围无效/)).toBeVisible();
  await page.getByLabel("电压最小值", { exact: true }).fill("0");
  await page.getByLabel("电压最大值", { exact: true }).fill("50");
  await page.getByLabel("电流最小值", { exact: true }).fill("-2");
  await page.getByLabel("电流最大值", { exact: true }).fill("5");
  await page.getByLabel("电压颜色", { exact: true }).fill("#aa33cc");
  await page.getByLabel("电压线宽", { exact: true }).fill("4");
  await page.getByRole("button", { name: "应用更改" }).click();
  await expect(page.getByText(/线宽范围为/)).toBeVisible();
  await page.getByLabel("电压线宽", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "应用更改" }).click();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("atorch-chart-bounds")!),
    ),
  ).toEqual({
    voltage: { min: 0, max: 50, color: "#aa33cc", width: 1.5 },
    current: { min: -2, max: 5 },
  });
  await page.reload();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await openCurveSettings(page);
  await expect(page.getByLabel("电流最小值", { exact: true })).toHaveValue(
    "-2",
  );
  await expect(page.getByLabel("电压最大值", { exact: true })).toHaveValue(
    "50",
  );
  await expect(page.getByLabel("电压颜色", { exact: true })).toHaveValue(
    "#aa33cc",
  );
  await expect(page.getByLabel("电压线宽", { exact: true })).toHaveValue("1.5");
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("atorch-chart-bounds")),
  ).toBe("{}");
});

test("chart image export calls the native PNG save path with real image bytes", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "截图", exact: true }).click();
  await expect(
    page.getByText("曲线图片已保存：fixture/chart.png"),
  ).toBeVisible();
  const saved = await page.evaluate(
    () =>
      (window as any).reviewCalls.findLast((c: any) => c.command === "save_png")
        .args,
  );
  expect(saved.name).toMatch(/^Atorch_chart_\d+\.png$/);
  expect(saved.dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(
    Buffer.from(saved.dataUrl.split(",")[1], "base64")
      .subarray(0, 8)
      .toString("hex"),
  ).toBe("89504e470d0a1a0a");
});

test("chart zoom survives repeated device snapshots", async ({ page }) => {
  await fixture(page, 101);
  const inspect = async (setZoom: boolean) =>
    page.evaluate(
      async ({ setZoom }) => {
        const url = performance
          .getEntriesByType("resource")
          .map((r) => r.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const core = await import(url);
        const chart = core.getInstanceByDom(
          document.querySelector(".trend-chart"),
        );
        if (setZoom)
          chart.dispatchAction({ type: "dataZoom", start: 20, end: 60 });
        const range = chart.getOption().dataZoom[0];
        return { startValue: range.startValue, endValue: range.endValue };
      },
      { setZoom },
    );
  const range = await inspect(true);
  await expect(
    page.getByRole("button", { name: "重置缩放", exact: true }),
  ).toBeEnabled();
  await page.waitForTimeout(1600);
  expect(await inspect(false)).toEqual(range);
  await page.getByRole("button", { name: "重置缩放", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重置缩放", exact: true }),
  ).toBeDisabled();
});

test("default voltage axis starts at zero and current zero remains centered", async ({
  page,
}) => {
  await fixture(page);
  const axes = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((r) => r.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const core = await import(url);
      const chart = core.getInstanceByDom(
        document.querySelector(".trend-chart"),
      );
      return [0, 1].map((index) =>
        chart.getModel().getComponent("yAxis", index).axis.scale.getExtent(),
      );
    });
  const [voltage, current] = await axes();
  expect(voltage[0]).toBe(0);
  expect(voltage[1]).toBeGreaterThanOrEqual(40);
  expect(current[0]).toBe(-current[1]);
  expect(current[1]).toBeGreaterThan(2);
  await openCurveSettings(page);
  await page.getByLabel("电流最小值", { exact: true }).fill("-2");
  await page.getByLabel("电流最大值", { exact: true }).fill("5");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  expect((await axes())[1]).toEqual([-2, 5]);
  await openCurveSettings(page);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  const restored = (await axes())[1];
  expect(restored[0]).toBe(-restored[1]);
});
