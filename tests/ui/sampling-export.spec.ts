import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(
  page: Page,
  options: {
    count?: number;
    bluetooth?: boolean;
    connected?: boolean;
    recording?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({
      count = 121,
      bluetooth = false,
      connected = true,
      recording = false,
    }) => {
      const base = new Date(2026, 10, 13, 10).getTime();
      const row = (index: number) => ({
        timestamp: base + index * 1000,
        elapsedMs: index * 1000,
        segmentId: 0,
        voltage: 12 + index / 100,
        current: 1,
        power: 12,
        resistance: 12,
        energy: 129.664,
        capacity: 6599,
        cpuTemperature: 30,
        ntcTemperature: 25,
        mosTemperature: 28,
        fanSpeed: 0,
        running: false,
        status: 0,
      });
      const state = {
        rows: Array.from({ length: count }, (_, index) => row(index)),
        paused: false,
        segment: 0,
        connected,
        cancelSave: false,
        failSave: false,
        historyDelay: 0,
        wallTime: base + Math.max(0, count - 1) * 1000,
        calls: [] as { command: string; args: any }[],
        tick(milliseconds = 1000) {
          this.wallTime += milliseconds;
          if (!this.paused)
            this.rows.push({
              ...row(this.rows.length),
              timestamp: this.wallTime,
              segmentId: this.segment,
              elapsedMs: this.rows.length
                ? this.rows.at(-1)!.elapsedMs + milliseconds
                : 0,
            });
        },
      };
      Object.assign(window, {
        isTauri: true,
        samplingFixture: state,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            state.calls.push({ command, args });
            if (command === "get_snapshot")
              return {
                connected: state.connected,
                device: {
                  path: "sampling-fixture",
                  name: "BW150",
                  serial: "UI fixture",
                  vendorId: 0x0483,
                  productId: 0x5750,
                  transport: bluetooth ? "bluetooth" : "usb",
                },
                telemetry: state.rows.at(-1) ?? row(0),
                settings: null,
                sampleCount: state.rows.length,
                samplingPaused: state.paused,
                samplingElapsedMs: state.rows.at(-1)?.elapsedMs ?? 0,
                connectedAt: base,
                lastReportAt: Date.now(),
                recording: recording ? "fixture/current.csv" : null,
                recordingPaused: state.paused,
                error: null,
                logs: [],
              };
            if (command === "get_history") {
              const rows = [...state.rows];
              await new Promise((resolve) =>
                setTimeout(resolve, state.historyDelay),
              );
              return rows;
            }
            if (command === "set_sampling") {
              if (!state.paused && !args.enabled) state.segment += 1;
              state.paused = !args.enabled;
              return;
            }
            if (command === "clear_samples") {
              state.rows = [];
              state.segment = 0;
              return;
            }
            if (command === "save_csv" || command === "save_png") {
              if (state.failSave) throw new Error("文件保存失败：磁盘只读");
              return state.cancelSave
                ? null
                : `fixture/${command === "save_csv" ? "selected.csv" : "selected.png"}`;
            }
            if (command === "list_recordings") return [];
            throw new Error(`Unexpected sampling UI command: ${command}`);
          },
        },
      });
    },
    options,
  );
  await page.goto("/");
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
  if (options.count !== 0)
    await expect(
      page.getByRole("button", { name: "导出", exact: true }),
    ).toBeEnabled();
}

async function zoom(page: Page, start: number, end: number) {
  return page.evaluate(
    async ({ start, end }) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      chart.dispatchAction({ type: "dataZoom", start, end });
      const range = chart.getOption().dataZoom[0];
      return {
        start: range.startValue as number,
        end: range.endValue as number,
      };
    },
    { start, end },
  );
}

for (const bluetooth of [false, true]) {
  test(`pause and resume control sample collection (${bluetooth ? "BLE" : "USB"})`, async ({
    page,
  }) => {
    await fixture(page, { bluetooth, recording: true });
    await expect(
      page.getByText(/本机记录已暂停|正在自动保存本机记录/),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^(开始|停止)记录$/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "继续", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText(/本机记录已暂停|正在自动保存本机记录/),
    ).toHaveCount(0);
    await page.evaluate(() => (window as any).samplingFixture.tick());
    expect(
      await page.evaluate(() => (window as any).samplingFixture.rows.length),
    ).toBe(121);
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "暂停", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => (window as any).samplingFixture.tick());
    expect(
      await page.evaluate(() => (window as any).samplingFixture.rows.length),
    ).toBe(122);
    const calls = await page.evaluate(() =>
      (window as any).samplingFixture.calls.filter(
        (call: any) => !["get_history", "get_snapshot"].includes(call.command),
      ),
    );
    expect(calls).toEqual([
      { command: "set_sampling", args: { enabled: false } },
      { command: "set_sampling", args: { enabled: true } },
    ]);
  });
}

test("clear requires confirmation, preserves data on cancel and ignores stale history", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续", exact: true }),
  ).toBeEnabled();
  await zoom(page, 20, 60);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "放弃当前采样记录？",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).samplingFixture.calls.filter(
        (call: any) => call.command === "clear_samples",
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).samplingFixture.rows.length),
  ).toBe(121);
  const historyCalls = await page.evaluate(
    () =>
      (window as any).samplingFixture.calls.filter(
        (call: any) => call.command === "get_history",
      ).length,
  );
  await page.evaluate(() => {
    (window as any).samplingFixture.historyDelay = 800;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).samplingFixture.calls.filter(
            (call: any) => call.command === "get_history",
          ).length,
      ),
    )
    .toBeGreaterThan(historyCalls);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await dialog.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(0);
  await expect(page.getByText("等待采样数据", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重置缩放", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeDisabled();
  await page.waitForTimeout(1700);
  expect((await chartState(page)).series[0].data.length).toBe(0);
  await expect(page.locator(".chart-empty")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "继续", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).samplingFixture.calls.filter(
        (call: any) => call.command === "clear_samples",
      ),
    ),
  ).toHaveLength(1);
});

test("live elapsed timeline freezes on pause, excludes the pause gap, and resets on clear", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  const inspect = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      const option = chart.getOption();
      return {
        type: option.xAxis[0].type,
        min: option.xAxis[0].min,
        max: option.xAxis[0].max,
        values: option.series[0].data.map((point: number[]) => point[0]),
      };
    });
  await expect.poll(async () => (await inspect()).values.length).toBe(121);
  expect(await inspect()).toMatchObject({
    type: "value",
    min: 0,
    max: 120_000,
  });
  expect((await inspect()).values[0]).toBe(0);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(30_000));
  await page.waitForTimeout(1150);
  expect(await inspect()).toMatchObject({ max: 120_000 });
  expect((await inspect()).values).toHaveLength(121);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(1234));
  await expect.poll(async () => (await inspect()).max).toBe(121_234);
  expect((await inspect()).values.at(-1)).toBe(121_234);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const csv = await page.evaluate(
    () =>
      (window as any).samplingFixture.calls.findLast(
        (call: any) => call.command === "save_csv",
      ).args.content as string,
  );
  const timestamp = csv.trim().split(/\r?\n/).at(-1)!.split(",")[0];
  expect(Date.parse(timestamp)).toBe(
    new Date(2026, 10, 13, 10).getTime() + 151_234,
  );
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect.poll(async () => (await inspect()).values.length).toBe(0);
  expect(await inspect()).toMatchObject({ min: 0, max: 1 });
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(1000));
  await expect.poll(async () => (await inspect()).values).toEqual([0]);
});

test("live and history tooltip time headers show seconds to two decimal places", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  await page.evaluate(() => {
    const row = (window as any).samplingFixture.rows[60];
    row.timestamp += 234;
    row.elapsedMs += 234;
  });
  const showTooltip = async () => {
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      chart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: 60 });
    });
  };
  await page.waitForTimeout(1150);
  await showTooltip();
  await expect(
    page.locator(".trend-chart").getByText("00:01:00.23", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
  await page.getByLabel("曲线时间坐标", { exact: true }).selectOption("clock");
  await showTooltip();
  await expect(
    page.locator(".trend-chart").getByText("10:01:00.23", { exact: true }),
  ).toBeVisible();
});

test("clear without samples does not ask for confirmation", async ({
  page,
}) => {
  await fixture(page, { count: 0, connected: false });
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).samplingFixture.calls.some(
          (call: any) => call.command === "clear_samples",
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".trend-chart canvas")).toBeVisible();
  await expect(page.getByText(/等待采样数据|连接设备后，实时曲线/)).toHaveCount(
    0,
  );
  const folder =
    process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/chart-interaction";
  await mkdir(folder, { recursive: true });
  await page
    .locator(".chart-card")
    .screenshot({ path: `${folder}/empty-chart.png` });
});

for (const timeMode of ["clock", "elapsed"]) {
  test(`live and history exports use the selected time and zoom range (${timeMode})`, async ({
    page,
  }) => {
    await fixture(page);
    await page
      .getByLabel("曲线时间坐标", { exact: true })
      .selectOption(timeMode);
    await zoom(page, 0, 25);
    await page.getByLabel("曲线时间范围", { exact: true }).selectOption("60");
    await expect(
      page.getByRole("button", { name: "导出", exact: true }),
    ).toBeEnabled();
    const selected = await zoom(page, 25, 75);
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const inspect = () =>
      page.evaluate(() => {
        const state = (window as any).samplingFixture;
        return {
          rows: state.rows,
          content: state.calls.findLast(
            (call: any) => call.command === "save_csv",
          ).args.content as string,
        };
      });
    let saved = await inspect();
    let expected = saved.rows.filter(
      (row: any) =>
        (timeMode === "elapsed" ? row.elapsedMs : row.timestamp) >=
          selected.start &&
        (timeMode === "elapsed" ? row.elapsedMs : row.timestamp) <=
          selected.end,
    );
    let cells = saved.content.trim().split(/\r?\n/).slice(1);
    expect(cells.length).toBe(expected.length);
    expect(cells.map((line) => Date.parse(line.split(",")[0]))).toEqual(
      expected.map((row: any) => row.timestamp),
    );
    expect(cells.length).toBeLessThan(61);
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    const historyRange = await zoom(page, 20, 60);
    await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
    saved = await inspect();
    expected = saved.rows.filter(
      (row: any) =>
        (timeMode === "elapsed" ? row.elapsedMs : row.timestamp) >=
          historyRange.start &&
        (timeMode === "elapsed" ? row.elapsedMs : row.timestamp) <=
          historyRange.end,
    );
    cells = saved.content.trim().split(/\r?\n/).slice(1);
    expect(cells.map((line) => Date.parse(line.split(",")[0]))).toEqual(
      expected.map((row: any) => row.timestamp),
    );
  });
}

test("time coordinate defaults to clock, is shared by live/history, persists, and resets incompatible zoom", async ({
  page,
}) => {
  await fixture(page);
  const select = () => page.getByLabel("曲线时间坐标", { exact: true });
  await expect(select()).toHaveValue("clock");
  await expect(select().locator("option")).toHaveText(["真实时间", "相对时间"]);
  await zoom(page, 20, 60);
  await select().selectOption("elapsed");
  await expect(
    page.getByRole("button", { name: "重置缩放", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(select()).toHaveValue("elapsed");
  await select().selectOption("clock");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await expect(select()).toHaveValue("clock");
  await select().selectOption("elapsed");
  await page.reload();
  await expect(select()).toHaveValue("elapsed");
  await select().selectOption("clock");
  await page.reload();
  await expect(select()).toHaveValue("clock");
});

test("PNG excludes the range bar, keeps zoom, and cancellation is silent", async ({
  page,
}) => {
  await fixture(page);
  const selected = await zoom(page, 20, 60);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    const original = chart.getDataURL.bind(chart);
    chart.getDataURL = (options: any) => {
      (window as any).imageOptions = options;
      return original(options);
    };
    (window as any).samplingFixture.cancelSave = true;
  });
  await page.getByRole("button", { name: "截图", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).samplingFixture.calls.filter(
            (call: any) => call.command === "save_png",
          ).length,
      ),
    )
    .toBe(1);
  const image = await page.evaluate(async () => {
    const state = (window as any).samplingFixture;
    const url = state.calls.findLast((call: any) => call.command === "save_png")
      .args.dataUrl;
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      width: image.width,
      height: image.height,
      chartHeight: document.querySelector(".trend-chart")!.clientHeight,
      options: (window as any).imageOptions,
    };
  });
  expect(image.height).toBe((image.chartHeight - 24) * 2);
  expect(image.options.excludeComponents).toEqual(["dataZoom"]);
  expect(await zoom(page, 20, 60)).toEqual(selected);
  await expect(page.getByText(/已保存|已取消保存/)).toHaveCount(0);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).samplingFixture.calls.filter(
            (call: any) => call.command === "save_csv",
          ).length,
      ),
    )
    .toBe(1);
  await expect(page.getByText(/已导出|已取消保存/)).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).samplingFixture.failSave = true;
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(
    page.locator(".fui-Toast").getByText(/文件保存失败：磁盘只读/),
  ).toBeVisible();
});

async function chartState(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const element = document.querySelector(".trend-chart")!;
    const chart = getInstanceByDom(element);
    const option = chart.getOption();
    const box = element.getBoundingClientRect();
    return {
      range: option.dataZoom[0],
      series: option.series.map((s: any) => ({ id: s.id, data: s.data })),
      axes: option.yAxis.map((axis: any) => ({
        unit: axis.id,
        min: axis.min,
        max: axis.max,
        position: axis.position,
        offset: axis.offset,
      })),
      grid: option.grid[0],
      width: chart.getWidth(),
      height: chart.getHeight(),
      left: box.left,
      top: box.top,
      rows: (window as any).samplingFixture.rows,
    };
  });
}

test("time divisions render dashed grids and every unit axis keeps its position after time-mode changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1050 });
  await fixture(page);
  for (const checkbox of await page
    .getByRole("group", { name: "曲线参数", exact: true })
    .getByRole("checkbox")
    .all())
    await checkbox.check();
  const inspect = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      const model = chart.getModel();
      const option = chart.getOption();
      const axes = option.yAxis.map((axis: any, index: number) => {
        const lines: number[] = [];
        chart
          .getViewOfComponentModel(model.getComponent("yAxis", index))
          .group.traverse((el: any) => {
            if (el.anid === "line" && !el.ignore && !el.invisible)
              lines.push(
                el.transformCoordToGlobal(el.shape.x1, el.shape.y1)[0],
              );
          });
        return { unit: axis.id, position: axis.position, lines };
      });
      let grids = 0;
      chart
        .getViewOfComponentModel(model.getComponent("xAxis"))
        .group.traverse((el: any) => {
          if (
            String(el.anid).startsWith("line_") &&
            el.style.lineDash &&
            !el.ignore &&
            !el.invisible
          )
            grids++;
        });
      return { axes, grids };
    });
  let baseline: number[] | undefined;
  for (const history of [false, true]) {
    if (history)
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
    for (const mode of ["clock", "elapsed", "clock"]) {
      await page.getByLabel("曲线时间坐标", { exact: true }).selectOption(mode);
      const state = await inspect();
      expect(state.axes).toHaveLength(8);
      expect(state.axes.every((axis: any) => axis.lines.length === 1)).toBe(
        true,
      );
      const positions = state.axes.map((axis: any) => axis.lines[0]);
      expect(new Set(positions).size).toBe(8);
      if (baseline) expect(positions).toEqual(baseline);
      else baseline = positions;
      expect(state.grids).toBeGreaterThan(1);
    }
  }
  await mkdir("artifacts/chart-detail-settings", { recursive: true });
  await page
    .locator(".review-card")
    .screenshot({ path: "artifacts/chart-detail-settings/history-axes.png" });
});

test("empty charts hide time ticks and hover pointers in both time modes and both pages", async ({
  page,
}) => {
  await fixture(page, { count: 0, connected: false });
  for (const history of [false, true]) {
    if (history)
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
    for (const mode of ["clock", "elapsed"]) {
      await page.getByLabel("曲线时间坐标", { exact: true }).selectOption(mode);
      const state = await chartState(page);
      await page.mouse.move(
        state.left + (state.grid.left + state.width - state.grid.right) / 2,
        state.top + 90,
      );
      await page.waitForTimeout(1100);
      const drawn = await page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        const chart = getInstanceByDom(document.querySelector(".trend-chart"));
        const elements = chart
          .getZr()
          .storage.getDisplayList(true)
          .filter((el: any) => !el.ignore && !el.invisible);
        return {
          text: elements
            .filter((el: any) => el.type === "tspan")
            .map((el: any) => String(el.style.text)),
          verticalDashes: elements.filter((el: any) => {
            if (el.type !== "line" || !el.style.lineDash?.length) return false;
            const rect = el.getBoundingRect().clone();
            rect.applyTransform(el.getComputedTransform());
            return rect.width < 2 && rect.height > 20;
          }).length,
        };
      });
      expect(
        drawn.text.some((text: string) => /\d{2}:\d{2}:\d{2}/.test(text)),
      ).toBe(false);
      expect(drawn.verticalDashes).toBe(0);
      await expect(page.locator(".curve-tooltip")).toBeHidden();
    }
  }
  await mkdir("artifacts/chart-detail-settings", { recursive: true });
  await page
    .locator(".review-card")
    .screenshot({ path: "artifacts/chart-detail-settings/empty-elapsed.png" });
});

test("unrecorded real time stays empty across pause, export and historical import", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(30_000));
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(1000));
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(123);
  const state = await chartState(page);
  const nulls = state.series[0].data.filter(
    (point: any[]) => point[1] === null,
  );
  expect(nulls).toHaveLength(1);
  expect(nulls[0][0]).toBe(
    (state.rows[120].timestamp + state.rows[121].timestamp) / 2,
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const content = await page.evaluate(
    () =>
      (window as any).samplingFixture.calls.findLast(
        (c: any) => c.command === "save_csv",
      ).args.content as string,
  );
  expect(content.trim().split(/\r?\n/)).toHaveLength(123);
  expect(content.split(/\r?\n/)[0]).toContain("ELAPSED_MS,SEGMENT_ID");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
    name: "paused.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(content),
  });
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(123);
  expect(
    (await chartState(page)).series[0].data.filter((p: any[]) => p[1] === null),
  ).toHaveLength(1);
  const folder =
    process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/chart-interaction";
  await mkdir(folder, { recursive: true });
  await page
    .locator(".review-card")
    .screenshot({ path: `${folder}/paused-real-time.png` });
  await page
    .getByLabel("曲线时间坐标", { exact: true })
    .selectOption("elapsed");
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(122);
  expect(
    (await chartState(page)).series[0].data.filter((p: any[]) => p[1] === null),
  ).toHaveLength(0);
});

for (const mode of ["clock", "elapsed"]) {
  test(`right endpoint follows latest data and a detached range stays fixed (${mode})`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByLabel("曲线时间坐标", { exact: true }).selectOption(mode);
    const selected = await zoom(page, 50, 100);
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await expect
      .poll(async () => (await chartState(page)).range.endValue)
      .toBeGreaterThan(selected.end);
    const following = await chartState(page);
    expect(following.range.startValue).toBe(selected.start);
    expect(following.range.end).toBe(100);
    const fixed = await zoom(page, 20, 70);
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await expect
      .poll(async () => (await chartState(page)).series[0].data.length)
      .toBe(123);
    const updated = await chartState(page);
    expect(updated.range.startValue).toBe(fixed.start);
    expect(updated.range.endValue).toBe(fixed.end);
    await page.getByRole("button", { name: "重置缩放", exact: true }).click();
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await expect
      .poll(async () => (await chartState(page)).series[0].data.length)
      .toBe(124);
    expect((await chartState(page)).range.end).toBe(100);
  });

  test(`statistics, details and CSV use exactly the selected chart range (${mode})`, async ({
    page,
  }) => {
    await fixture(page);
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    await page.getByLabel("曲线时间坐标", { exact: true }).selectOption(mode);
    const range = await zoom(page, 25, 50);
    const state = await chartState(page);
    const rows = state.rows.filter(
      (r: any) =>
        (mode === "clock" ? r.timestamp : r.elapsedMs) >= range.start &&
        (mode === "clock" ? r.timestamp : r.elapsedMs) <= range.end,
    );
    const stats = page
      .getByRole("table", { name: "采样统计" })
      .getByRole("row")
      .filter({ hasText: "电压 / V" });
    await expect(stats.getByRole("cell").nth(1)).toHaveText(
      String(rows.length),
    );
    await expect(stats.getByRole("cell").nth(2)).toHaveText(
      String(rows[0].voltage),
    );
    await expect(stats.getByRole("cell").nth(3)).toHaveText(
      String(rows.at(-1).voltage),
    );
    await expect(
      page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
    ).toHaveCount(Math.min(10, rows.length));
    await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
    const csv = await page.evaluate(
      () =>
        (window as any).samplingFixture.calls.findLast(
          (c: any) => c.command === "save_csv",
        ).args.content as string,
    );
    expect(csv.trim().split(/\r?\n/).length - 1).toBe(rows.length);
    await page.getByRole("button", { name: "重置缩放", exact: true }).click();
    await expect(stats.getByRole("cell").nth(1)).toHaveText("121");
  });
}

test("stationary mouse keeps the tooltip visible across incoming samples and hides on leave", async ({
  page,
}) => {
  await fixture(page);
  const state = await chartState(page);
  await page.mouse.move(
    state.left + (state.grid.left + state.width - state.grid.right) / 2,
    state.top + 80,
  );
  const tip = page
    .locator(".trend-chart")
    .getByText("电压 (V)", { exact: true });
  await expect(tip).toBeVisible();
  await expect(
    page.locator(".curve-tooltip").getByText("电流 (A)", { exact: true }),
  ).toHaveCount(1);
  for (let i = 1; i <= 3; i++) {
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await expect
      .poll(async () => (await chartState(page)).series[0].data.length)
      .toBe(121 + i);
    await expect(tip).toBeVisible();
    await expect(
      page.locator(".curve-tooltip").getByText("电流 (A)", { exact: true }),
    ).toHaveCount(1);
  }
  await page.mouse.move(10, 10);
  await expect(tip).toBeHidden();
  await page.evaluate(() => (window as any).samplingFixture.tick());
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(125);
  await expect(tip).toBeHidden();
});

test("wheel over each unit axis zooms only that axis and reset restores all axes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1100 });
  await fixture(page);
  for (const name of [
    "功率 (W)",
    "电阻 (Ω)",
    "电量 (Wh)",
    "容量 (mAh)",
    "CPU 温度 (°C)",
    "探头温度 (°C)",
    "MOS 温度 (°C)",
    "风扇 (RPM)",
  ])
    await page.getByRole("checkbox", { name, exact: true }).check();
  const initial = await chartState(page);
  expect(initial.axes).toHaveLength(8);
  for (let index = 0; index < initial.axes.length; index++) {
    const before = await chartState(page);
    const axis = before.axes[index];
    const x =
      axis.position === "left"
        ? before.grid.left - axis.offset - 12
        : before.width - before.grid.right + axis.offset + 12;
    const scroll = await page.evaluate(() => window.scrollY);
    await page.mouse.move(before.left + x, before.top + 100);
    await page.mouse.wheel(0, -120);
    await expect
      .poll(async () => {
        const after = await chartState(page);
        return after.axes[index].max - after.axes[index].min;
      })
      .toBeLessThan(axis.max - axis.min);
    const after = await chartState(page);
    for (let other = 0; other < after.axes.length; other++)
      if (other !== index)
        expect(after.axes[other]).toMatchObject({
          min: before.axes[other].min,
          max: before.axes[other].max,
          unit: before.axes[other].unit,
        });
    expect(after.range.startValue).toBe(before.range.startValue);
    expect(after.range.endValue).toBe(before.range.endValue);
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  }
  const state = await chartState(page);
  await page.mouse.move(
    state.left + (state.grid.left + state.width - state.grid.right) / 2,
    state.top + state.height - 40,
  );
  await page.mouse.wheel(0, -120);
  await expect
    .poll(
      async () =>
        (await chartState(page)).range.end -
        (await chartState(page)).range.start,
    )
    .toBeLessThan(100);
  const afterTime = await chartState(page);
  expect(afterTime.axes).toEqual(state.axes);
  await page.getByRole("button", { name: "重置缩放", exact: true }).click();
  await expect
    .poll(async () => (await chartState(page)).axes)
    .toEqual(initial.axes);
  expect((await chartState(page)).range.end).toBe(100);
  await expect(
    page.getByRole("button", { name: "重置缩放", exact: true }),
  ).toBeDisabled();
});

for (const dragTarget of ["plot", "range bar"]) {
  test(`horizontal ${dragTarget} panning keeps its gesture across live refreshes and catches up on release`, async ({
    page,
  }) => {
    await fixture(page);
    await zoom(page, 30, 80);
    const state = await chartState(page);
    const x =
      state.left + (state.grid.left + state.width - state.grid.right) / 2;
    const y = state.top + (dragTarget === "plot" ? 110 : state.height - 9);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 5 });
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).samplingFixture.calls.filter(
              (c: any) => c.command === "get_history",
            ).length,
        ),
      )
      .toBeGreaterThan(1);
    await page.waitForTimeout(1100);
    const first = await chartState(page);
    expect(first.series[0].data.length).toBe(121);
    await page.mouse.move(x + 70, y, { steps: 5 });
    await expect
      .poll(async () =>
        Math.abs(
          (await chartState(page)).range.startValue - first.range.startValue,
        ),
      )
      .toBeGreaterThan(1);
    await page.mouse.up();
    await expect
      .poll(async () => (await chartState(page)).series[0].data.length)
      .toBe(122);
    const final = await chartState(page);
    const direction = dragTarget === "plot" ? -1 : 1;
    expect(
      (final.range.startValue - first.range.startValue) * direction,
    ).toBeGreaterThan(0);
    expect(
      (final.range.endValue - first.range.endValue) * direction,
    ).toBeGreaterThan(0);
  });
}

test("an empty real-time gap has zero statistics and cannot export fabricated data", async ({
  page,
}) => {
  await fixture(page, { count: 4 });
  await page.evaluate(() => {
    for (const row of (window as any).samplingFixture.rows.slice(2)) {
      row.timestamp += 60_000;
      row.segmentId = 1;
    }
  });
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect
    .poll(async () => (await chartState(page)).series[0].data.length)
    .toBe(5);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const base = (window as any).samplingFixture.rows[0].timestamp;
    getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction({
      type: "dataZoom",
      startValue: base + 10_000,
      endValue: base + 50_000,
    });
  });
  const row = page
    .getByRole("table", { name: "采样统计" })
    .getByRole("row")
    .filter({ hasText: "电压 / V" });
  await expect(row.getByRole("cell")).toHaveText([
    "电压 / V",
    "0",
    "—",
    "—",
    "—",
  ]);
  await expect(
    page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重置缩放", exact: true }).click();
  await expect(row.getByRole("cell").nth(1)).toHaveText("4");
});

test("export and screenshot stay on the left, with reset at the lower right on both pages", async ({
  page,
}) => {
  await fixture(page);
  for (const history of [false, true]) {
    if (history)
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
    const footer = page.locator(".chart-image-actions");
    const names = await footer.getByRole("button").allTextContents();
    expect(names).toEqual(
      history
        ? ["导出 CSV", "截图", "重置缩放"]
        : ["暂停", "清空", "导出", "截图", "重置缩放"],
    );
    const exported = await footer
      .getByRole("button", { name: history ? "导出 CSV" : "导出", exact: true })
      .boundingBox();
    const image = await footer
      .getByRole("button", { name: "截图", exact: true })
      .boundingBox();
    const reset = await footer
      .getByRole("button", { name: "重置缩放", exact: true })
      .boundingBox();
    expect(image!.x).toBeGreaterThan(exported!.x + exported!.width);
    expect(image!.height).toBe(exported!.height);
    expect(reset!.height).toBe(exported!.height);
    expect(image!.x - exported!.x - exported!.width).toBeLessThanOrEqual(9);
    expect(reset!.x).toBeGreaterThan(image!.x + image!.width + 30);
    expect(
      await page
        .locator(".section-head")
        .getByRole("button", { name: "导出 CSV", exact: true })
        .count(),
    ).toBe(0);
    const folder =
      process.env.ATORCH_ARTIFACT_DIR ?? "artifacts/chart-interaction";
    await mkdir(folder, { recursive: true });
    await page.locator(history ? ".review-card" : ".chart-card").screenshot({
      path: `${folder}/${history ? "history" : "live"}-controls.png`,
    });
    await page.setViewportSize({ width: 390, height: 1050 });
    await page
      .locator(history ? ".review-card" : ".chart-card")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(
      page.getByRole("button", { name: "截图", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "截图", exact: true })
      .click({ trial: true });
    const footerBox = await footer.boundingBox();
    const resetBox = await footer
      .getByRole("button", { name: "重置缩放", exact: true })
      .boundingBox();
    const mobileExport = await footer
      .getByRole("button", { name: history ? "导出 CSV" : "导出", exact: true })
      .boundingBox();
    const mobileImage = await footer
      .getByRole("button", { name: "截图", exact: true })
      .boundingBox();
    expect(mobileImage!.y + mobileImage!.height / 2).toBe(
      mobileExport!.y + mobileExport!.height / 2,
    );
    expect(mobileImage!.height).toBe(mobileExport!.height);
    expect(resetBox!.height).toBe(mobileExport!.height);
    expect(
      mobileImage!.x - mobileExport!.x - mobileExport!.width,
    ).toBeLessThanOrEqual(9);
    expect(resetBox!.x + resetBox!.width).toBeCloseTo(
      footerBox!.x + footerBox!.width,
      0,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.locator(history ? ".review-card" : ".chart-card").screenshot({
      path: `${folder}/${history ? "history" : "live"}-controls-mobile.png`,
    });
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
});
