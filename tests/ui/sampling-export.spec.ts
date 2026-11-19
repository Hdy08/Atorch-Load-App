import { chooseMenu, expectMenuOptions } from "./menu";
import { expect, test, type Page, type CDPSession } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function fixture(
  page: Page,
  options: {
    count?: number;
    bluetooth?: boolean;
    connected?: boolean;
    recording?: boolean;
    stepVoltage?: boolean;
    emptyCurves?: boolean;
    gap?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({
      count = 121,
      bluetooth = false,
      connected = true,
      recording = false,
      stepVoltage = false,
      emptyCurves = false,
      gap = false,
    }) => {
      const base = new Date(2026, 10, 13, 10).getTime();
      const row = (index: number) => ({
        timestamp:
          base + index * 1000 + (gap && index >= count / 2 ? 120_000 : 0),
        elapsedMs: index * 1000,
        segmentId: gap && index >= count / 2 ? 1 : 0,
        voltage: emptyCurves
          ? null
          : stepVoltage
            ? index < count / 2
              ? 5
              : 0
            : 12 + index / 100,
        current: emptyCurves ? null : 1,
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
        elapsedAdvance: 0,
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
            if (command === "set_window_theme") return false;
            if (command === "set_chart_fullscreen") return true;
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
                samplingElapsedMs:
                  (state.rows.at(-1)?.elapsedMs ?? 0) + state.elapsedAdvance,
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
  test(`automatically paused sampling can be resumed manually (${bluetooth ? "BLE" : "USB"})`, async ({
    page,
  }) => {
    await fixture(page, { bluetooth, recording: true });
    await page.evaluate(() => {
      const state = (window as any).samplingFixture;
      state.paused = true;
      state.segment += 1;
    });
    const resume = page.getByRole("button", { name: "继续", exact: true });
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(
      page.getByRole("button", { name: "暂停", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => (window as any).samplingFixture.tick());
    expect(
      await page.evaluate(() => (window as any).samplingFixture.rows.length),
    ).toBe(122);
    expect(
      await page.evaluate(() =>
        (window as any).samplingFixture.calls.filter(
          (c: any) => c.command === "set_sampling",
        ),
      ),
    ).toEqual([{ command: "set_sampling", args: { enabled: true } }]);
  });

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
        (call: any) =>
          ![
            "get_history",
            "get_snapshot",
            "set_window_theme",
            "get_system_accent",
            "get_system_theme",
          ].includes(call.command),
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
    page.getByRole("button", { name: "复原", exact: true }),
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
  await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), "elapsed");
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
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.evaluate(() => (window as any).samplingFixture.tick(1000));
  await expect.poll(async () => (await inspect()).values).toEqual([0]);
});

test("live and history tooltip time headers show seconds to two decimal places", async ({
  page,
}) => {
  await fixture(page);
  await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), "elapsed");
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
  await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), "clock");
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
    await chooseMenu(
      page.getByLabel("曲线时间坐标", { exact: true }),
      timeMode,
    );
    await zoom(page, 0, 25);
    await chooseMenu(page.getByLabel("曲线时间范围", { exact: true }), "60");
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
    await page.getByRole("button", { name: "导出", exact: true }).click();
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
  await expect(select()).toHaveAttribute("data-value", "clock");
  await expectMenuOptions(select(), ["绝对时间", "相对时间"]);
  await zoom(page, 20, 60);
  await chooseMenu(select(), "elapsed");
  await expect(
    page.getByRole("button", { name: "复原", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(select()).toHaveAttribute("data-value", "elapsed");
  await chooseMenu(select(), "clock");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await expect(select()).toHaveAttribute("data-value", "clock");
  await chooseMenu(select(), "elapsed");
  await page.reload();
  await expect(select()).toHaveAttribute("data-value", "elapsed");
  await chooseMenu(select(), "clock");
  await page.reload();
  await expect(select()).toHaveAttribute("data-value", "clock");
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
  expect(image.height).toBe((image.chartHeight - 18) * 2);
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
        interval: axis.interval,
        position: axis.position,
        offset: axis.offset,
      })),
      grid: option.grid[0],
      width: chart.getWidth(),
      height: chart.getHeight(),
      left: box.left,
      top: box.top,
      scaleX: box.width / chart.getWidth(),
      scaleY: box.height / chart.getHeight(),
      physicalWidth: box.width,
      physicalHeight: box.height,
      rotated: !!element.closest(".chart-fullscreen-rotated"),
      rows: (window as any).samplingFixture.rows,
    };
  });
}

for (const count of [4, 20_001]) {
  test(`pause gaps hide hover lines, dots and tooltip across the entire gap (${count} samples)`, async ({
    page,
  }) => {
    await fixture(page, { count });
    const gap = await page.evaluate(() => {
      const state = (window as any).samplingFixture;
      const half = Math.floor(state.rows.length / 2);
      for (const row of state.rows.slice(half)) {
        row.timestamp += 60_000;
        row.segmentId = 1;
      }
      const last = state.rows.at(-1);
      state.rows.push({
        ...last,
        timestamp: last.timestamp + 1000,
        elapsedMs: last.elapsedMs + 1000,
      });
      return [state.rows[half - 1].timestamp, state.rows[half].timestamp];
    });
    await expect(page.locator(".trend-chart")).toHaveAttribute(
      "data-source-count",
      String(count + 1),
    );
    const hover = async (time: number) => {
      const point = await page.evaluate(async (time) => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        const element = document.querySelector(".trend-chart")!;
        const chart = getInstanceByDom(element);
        const box = element.getBoundingClientRect();
        return {
          x: box.left + chart.convertToPixel({ xAxisIndex: 0 }, time),
          y: box.top + 80,
        };
      }, time);
      await page.mouse.move(point.x, point.y);
    };
    const pointerStatus = () =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        const model = getInstanceByDom(document.querySelector(".trend-chart"))
          .getModel()
          .getComponent("axisPointer");
        return Object.values(model.coordSysAxesInfo.axesInfo)
          .filter((info: any) => info.axis.dim === "x")
          .map((info: any) => info.axisPointerModel.get("status"))[0];
      });
    for (const review of [false, true]) {
      if (review)
        await page
          .getByRole("button", { name: "数据记录", exact: true })
          .click();
      await page.evaluate(async (gap) => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction(
          {
            type: "dataZoom",
            startValue: gap[0] - 1000,
            endValue: gap[1] + 1000,
          },
        );
      }, gap);
      await hover(gap[0] - 500);
      await expect(page.locator(".curve-tooltip")).toBeVisible();
      await expect.poll(pointerStatus).toBe("show");
      for (const ratio of [0.05, 0.5, 0.95]) {
        await hover(gap[0] + (gap[1] - gap[0]) * ratio);
        await expect.poll(pointerStatus).toBe("hide");
        await expect(page.locator(".curve-tooltip")).toBeHidden();
        await expect(page.locator(".chart-hover-marker")).toHaveCount(0);
        if (count === 4 && ratio === 0.5)
          await page.locator(".chart-wrap").screenshot({
            path: test
              .info()
              .outputPath(`gap-${review ? "review" : "live"}.png`),
          });
      }
      await hover(gap[1] + 500);
      await expect(page.locator(".curve-tooltip")).toBeVisible();
      await expect(page.locator(".chart-hover-marker")).toHaveCount(2);
    }
  });
}

for (const scale of [75, 100, 150]) {
  test(`height dragging keeps page position and card top stable at ${scale}% scale`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.addInitScript((scale) => {
      localStorage.setItem("atorch-appearance", JSON.stringify({ scale }));
      localStorage.setItem("atorch-chart-height", "490");
    }, scale);
    await fixture(page);
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    const handle = page.getByRole("separator", {
      name: "调整曲线高度",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const initial = await page.evaluate(() => ({
      scroll: document.querySelector(".main-shell")!.scrollTop,
      top: document.querySelector(".review-card")!.getBoundingClientRect().top,
    }));
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const frames = [];
    for (const delta of [20, 45, 80, 120, 160, 120, 80, 45, 20, 0]) {
      await page.mouse.move(x, y + (delta * scale) / 100, { steps: 3 });
      await page.waitForTimeout(40);
      frames.push(
        await page.evaluate(() => ({
          scroll: document.querySelector(".main-shell")!.scrollTop,
          top: document.querySelector(".review-card")!.getBoundingClientRect()
            .top,
          height: Number(
            document
              .querySelector(".chart-resize-handle")!
              .getAttribute("aria-valuenow"),
          ),
          canvas: document
            .querySelector(".trend-chart canvas")!
            .getBoundingClientRect().height,
        })),
      );
    }
    await page.mouse.up();
    expect(frames.map((frame) => frame.height)).toEqual([
      510, 535, 570, 610, 650, 610, 570, 535, 510, 490,
    ]);
    for (const frame of frames) {
      expect(Math.abs(frame.scroll - initial.scroll)).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.top - initial.top)).toBeLessThanOrEqual(1);
      expect(frame.canvas).toBeCloseTo((frame.height * scale) / 100, 0);
    }
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("atorch-chart-height")),
      )
      .toBe("490");
  });
}

test.describe("touch height dragging", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("mobile touch resize crosses the grid threshold without moving the page", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("atorch-appearance", JSON.stringify({ scale: 75 }));
      localStorage.setItem("atorch-chart-height", "490");
    });
    await fixture(page);
    const handle = page.getByRole("separator", {
      name: "调整曲线高度",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const initial = await page.evaluate(() => ({
      scroll: document.querySelector(".main-shell")!.scrollTop,
      top: document.querySelector(".chart-card")!.getBoundingClientRect().top,
    }));
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (const delta of [15, 45, 75, 120]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + delta }],
      });
      await expect(handle).toHaveAttribute(
        "aria-valuenow",
        String(490 + delta / 0.75),
      );
      const frame = await page.evaluate(() => ({
        scroll: document.querySelector(".main-shell")!.scrollTop,
        top: document.querySelector(".chart-card")!.getBoundingClientRect().top,
      }));
      expect(frame.scroll).toBeCloseTo(initial.scroll, 0);
      expect(frame.top).toBeCloseTo(initial.top, 0);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("atorch-chart-height")),
      )
      .toBe("650");
    await expect(handle).toHaveAttribute(
      "aria-valuetext",
      "650 像素，纵轴 10 格",
    );
    await page
      .locator(".chart-card")
      .screenshot({ path: test.info().outputPath("mobile-resized-chart.png") });
  });
});

for (const scale of [75, 100, 150]) {
  test(`shrinking a tall live chart keeps scrolled page edges stable at ${scale}%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript((scale) => {
      localStorage.setItem("atorch-appearance", JSON.stringify({ scale }));
      localStorage.setItem("atorch-chart-height", "950");
    }, scale);
    await fixture(page);
    await page.evaluate(() => {
      const shell = document.querySelector(".main-shell")!;
      shell.scrollTop = Math.max(
        0,
        shell.scrollHeight - shell.clientHeight - 30,
      );
    });
    const handle = page.getByRole("separator", {
      name: "调整曲线高度",
      exact: true,
    });
    await handle.scrollIntoViewIfNeeded();
    const initial = (await page.locator(".chart-card").boundingBox())!;
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const frames = [];
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let delta = 10; delta <= 350; delta += 10) {
      await page.mouse.move(x, y - (delta * scale) / 100);
      await page.waitForTimeout(20);
      frames.push(await page.locator(".chart-card").boundingBox());
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
    frames.push(await page.locator(".chart-card").boundingBox());
    await test.info().attach("shrinking-frames.json", {
      body: JSON.stringify({ scale, initial, frames }, null, 2),
      contentType: "application/json",
    });
    for (const frame of frames) {
      expect(
        Math.abs(frame!.y - initial.y),
        "page moved vertically while resizing an already ten-grid chart",
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(frame!.x + frame!.width - initial.x - initial.width),
        "right card edge moved while resizing",
      ).toBeLessThanOrEqual(1);
    }
    await page.locator(".main-shell").evaluate((shell) => {
      shell.scrollTop = 0;
    });
    await expect
      .poll(() => page.locator("main").evaluate((main) => main.style.minHeight))
      .toBe("");
  });

  test(`ten-grid height drag stays stable when the page starts overflowing at ${scale}%`, async ({
    page,
  }) => {
    await page.addInitScript((scale) => {
      localStorage.setItem("atorch-appearance", JSON.stringify({ scale }));
      localStorage.setItem("atorch-chart-height", "550");
    }, scale);
    await fixture(page);
    const content = await page.evaluate(
      () => document.querySelector("main")!.getBoundingClientRect().height,
    );
    await page.setViewportSize({
      width: 1440,
      height: Math.ceil(content + 100),
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector(".main-shell")!.scrollHeight -
            document.querySelector(".main-shell")!.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(0);
    const handle = page.getByRole("separator", {
      name: "调整曲线高度",
      exact: true,
    });
    await expect(handle).toHaveAttribute(
      "aria-valuetext",
      "550 像素，纵轴 10 格",
    );
    const initial = await page.locator(".chart-card").boundingBox();
    await page.evaluate(() => {
      const state = { frames: [] as any[], active: true };
      Object.assign(window, { resizeTrace: state });
      const record = () => {
        const card = document
          .querySelector(".chart-card")!
          .getBoundingClientRect();
        const chart = document
          .querySelector(".trend-chart")!
          .getBoundingClientRect();
        const shell = document.querySelector(".main-shell")!;
        state.frames.push({
          card: {
            x: card.x,
            y: card.y,
            width: card.width,
            height: card.height,
          },
          chart: { width: chart.width, height: chart.height },
          canvasWidth: document
            .querySelector(".trend-chart canvas")!
            .getBoundingClientRect().width,
          scroll: shell.scrollTop,
          gutter: (shell as HTMLElement).offsetWidth - shell.clientWidth,
          overflow: shell.scrollHeight > shell.clientHeight,
        });
        if (state.active) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let delta = 5; delta <= 400; delta += 5) {
      await page.mouse.move(x, y + (delta * scale) / 100);
      await page.waitForTimeout(18);
    }
    for (let delta = 395; delta >= 0; delta -= 5) {
      await page.mouse.move(x, y + (delta * scale) / 100);
      await page.waitForTimeout(18);
    }
    await page.mouse.up();
    const frames = await page.evaluate(() => {
      const state = (window as any).resizeTrace;
      state.active = false;
      return state.frames;
    });
    await test.info().attach("resize-frames.json", {
      body: JSON.stringify({ scale, initial, frames }, null, 2),
      contentType: "application/json",
    });
    expect(frames.some((frame: any) => frame.overflow)).toBe(true);
    expect(frames.some((frame: any) => !frame.overflow)).toBe(true);
    const top = frames.map((frame: any) => frame.card.y);
    const widths = frames.map((frame: any) => frame.card.width);
    const extra = frames.map(
      (frame: any) => frame.card.height - frame.chart.height,
    );
    expect(
      Math.max(...widths) - Math.min(...widths),
      "card width changed during a vertical drag",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...top) - Math.min(...top),
      "card top shifted during a vertical drag",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...extra) - Math.min(...extra),
      "card layout height changed independently of chart height",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(
        ...frames.map((frame: any) =>
          Math.abs(frame.canvasWidth - frame.chart.width),
        ),
      ),
      "canvas width lagged behind its container",
    ).toBeLessThanOrEqual(1);
  });
}

async function exactAxisTicks(page: Page) {
  return page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    const model = chart.getModel();
    const grid = model.getComponent("grid").coordinateSystem.getRect();
    const display = chart.getZr().storage.getDisplayList(true);
    const lines = display
      .filter(
        (el: any) =>
          el.type === "line" &&
          !el.ignore &&
          !el.invisible &&
          Math.abs(el.shape.y1 - el.shape.y2) < 0.1 &&
          Math.abs(el.shape.x2 - el.shape.x1) >= grid.width - 1,
      )
      .map((el: any) => el.shape.y1);
    const text = display
      .filter((el: any) => el.type === "tspan" && !el.ignore && !el.invisible)
      .map((el: any) => String(el.style.text).trim());
    return {
      lines,
      text,
      axes: chart.getOption().yAxis.map((option: any, i: number) => ({
        unit: option.id,
        min: option.min,
        max: option.max,
        interval: option.interval,
        ticks: model
          .getComponent("yAxis", i)
          .axis.scale.getTicks()
          .map(({ value }: any) => ({
            value,
            label: option.axisLabel.formatter(value).trim(),
            y: chart.convertToPixel({ yAxisIndex: i }, value),
          })),
      })),
    };
  });
}

async function expectExactAxisTicks(page: Page) {
  const result = await exactAxisTicks(page);
  const positions = result.axes[0].ticks.map((tick: any) => tick.y);
  for (const axis of result.axes) {
    expect(axis.ticks.length).toBe(positions.length);
    for (const [i, tick] of axis.ticks.entries()) {
      expect(tick.y).toBeCloseTo(positions[i], 6);
      // Canvas strokes are snapped to physical pixel centers by ECharts.
      expect(
        result.lines.some((y: number) => Math.abs(y - tick.y) < 1.01),
      ).toBe(true);
      expect(result.text).toContain(tick.label);
      const number = tick.label.slice(0, -axis.unit.length).trim();
      expect(Number(number)).toBeCloseTo(tick.value, 8);
      expect((number.split(".")[1] ?? "").length).toBeLessThanOrEqual(1);
      if (Math.abs(tick.value) > 1e-9) {
        const absolute = Math.abs(tick.value);
        const n = Math.floor(Math.log10(absolute) + 1e-10);
        const k = absolute / (0.5 * 10 ** n);
        expect(n).toBeGreaterThanOrEqual(-1);
        expect(k).toBeGreaterThanOrEqual(2 - 1e-8);
        expect(k).toBeLessThan(20);
        expect(k).toBeCloseTo(Math.round(k), 8);
      }
      if (i)
        expect(tick.value - axis.ticks[i - 1].value).toBeCloseTo(
          axis.interval,
          8,
        );
    }
  }
  return result;
}

test("all unit ticks stay exact, legal and aligned with the same grid after custom ranges and zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await fixture(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "atorch-chart-bounds",
      JSON.stringify({
        voltage: { min: -8.7, max: 21.3 },
        current: { min: -28.6, max: 21.4 },
        power: { min: -283.9, max: 216.1 },
        fanSpeed: { min: -1960.9, max: 2039.1 },
      }),
    ),
  );
  await page.reload();
  for (const name of [
    "功率",
    "电阻",
    "电量",
    "容量",
    "CPU 温度",
    "MOS 温度",
    "NTC 温度",
    "风扇转速",
  ])
    await page.getByRole("checkbox", { name, exact: true }).check();
  await expect
    .poll(async () => (await exactAxisTicks(page)).axes.length)
    .toBe(8);
  await expectExactAxisTicks(page);
  await page
    .getByRole("separator", { name: "调整曲线高度", exact: true })
    .press("End");
  await expect
    .poll(async () => (await exactAxisTicks(page)).axes[0].ticks.length)
    .toBe(11);
  await expectExactAxisTicks(page);
  for (const delta of [-120, 120, -120, -120]) {
    const state = await chartState(page);
    await page.mouse.move(state.left + state.grid.left - 16, state.top + 100);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, delta);
    await page.keyboard.up("Control");
    await page.waitForTimeout(50);
    await expectExactAxisTicks(page);
  }
  await page
    .locator(".chart-card")
    .screenshot({ path: test.info().outputPath("exact-all-axes.png") });
  await page.evaluate(() =>
    localStorage.setItem(
      "atorch-chart-bounds",
      JSON.stringify({ voltage: { min: -51, max: -50 } }),
    ),
  );
  await page.reload();
  await expectExactAxisTicks(page);
  await page
    .locator(".chart-card")
    .screenshot({ path: test.info().outputPath("exact-negative-axis.png") });
});

test("small signed current keeps zero centered on ten exact shared grids", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const state = (window as any).samplingFixture;
    for (const row of state.rows) row.current = 0.03;
    const last = state.rows.at(-1);
    state.rows.push({
      ...last,
      timestamp: last.timestamp + 1000,
      elapsedMs: last.elapsedMs + 1000,
    });
  });
  await expect
    .poll(async () => (await exactAxisTicks(page)).axes[1].interval)
    .toBe(0.1);
  const result = await expectExactAxisTicks(page);
  expect(result.axes.every((axis: any) => axis.ticks.length === 11)).toBe(true);
  const current = result.axes.find((axis: any) => axis.unit === "A");
  expect(current.min).toBe(-0.5);
  expect(current.max).toBe(0.5);
});

test("Y steps use only decimal 1/2/5 values and follow visible negative data limits", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const state = (window as any).samplingFixture;
    for (let i = 0; i < state.rows.length; i++)
      state.rows[i].voltage = i < 60 ? -(i % 4) / 100 : -50 - (i % 4) / 10;
    const last = state.rows.at(-1);
    state.rows.push({
      ...last,
      timestamp: last.timestamp + 1000,
      elapsedMs: last.elapsedMs + 1000,
    });
  });
  await expect(page.locator(".trend-chart")).toHaveAttribute(
    "data-source-count",
    "122",
  );
  const verify = async (maximum: number) => {
    const state = await chartState(page);
    const axis = state.axes.find((axis: any) => axis.unit === "V")!;
    expect(axis.interval).toBeGreaterThanOrEqual(0.1);
    expect(axis.interval).toBeLessThanOrEqual(Math.max(0.1, maximum));
    const scale = 10 ** Math.floor(Math.log10(axis.interval));
    expect(
      [1, 2, 5].some(
        (multiple) => Math.abs(axis.interval / scale - multiple) < 1e-8,
      ),
    ).toBe(true);
    return axis;
  };
  await expect
    .poll(async () => (await chartState(page)).axes[0].min)
    .toBeLessThan(-50);
  await verify(50.3);
  await zoom(page, 0, 40);
  await expect
    .poll(async () => (await chartState(page)).axes[0].interval)
    .toBe(0.1);
  await verify(0.03);
  await page.keyboard.down("Control");
  for (let i = 0; i < 20; i++) {
    const state = await chartState(page);
    await page.mouse.move(state.left + state.grid.left - 16, state.top + 100);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(20);
    await verify(0.03);
  }
  await page.keyboard.up("Control");
  const bounded = await chartState(page);
  expect(bounded.axes[0].max - bounded.axes[0].min).toBeCloseTo(0.5, 8);
  await page
    .locator(".chart-card")
    .screenshot({ path: test.info().outputPath("bounded-negative-axis.png") });
});

test("curve parameters stay in one row, toggle overflow and share selection with fullscreen and history", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const group = () =>
    page.getByRole("group", { name: "曲线参数", exact: true });
  const more = () => group().getByRole("button", { name: "更多曲线参数" });
  await group().scrollIntoViewIfNeeded();
  await expect(more()).toBeVisible();
  const initial = await group().getByRole("checkbox").count();
  expect(initial).toBeGreaterThan(0);
  expect(initial).toBeLessThan(10);
  const height = (await group().boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(36);
  await more().click();
  const overflow = page.getByRole("group", {
    name: "更多曲线参数",
    exact: true,
  });
  await expect(overflow).toBeVisible();
  expect(await overflow.getByRole("checkbox").count()).toBe(10 - initial);
  await overflow
    .getByRole("checkbox", { name: "NTC 温度", exact: true })
    .check();
  expect((await group().boundingBox())!.height).toBe(height);
  await page.screenshot({ path: info.outputPath("single-row-more.png") });
  await more().click();
  await expect(overflow).toBeHidden();
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  const fullscreen = page.locator("dialog:modal");
  const toolbar = fullscreen.locator(".chart-fullscreen-toolbar");
  await expect(
    toolbar.getByRole("group", { name: "曲线参数", exact: true }),
  ).toBeVisible();
  const box = (await toolbar.boundingBox())!;
  const exit = (await toolbar
    .getByRole("button", { name: "退出" })
    .boundingBox())!;
  expect(exit.y + exit.height / 2).toBeCloseTo(box.y + box.height / 2, 1);
  await more().click();
  await expect(
    overflow.getByRole("checkbox", { name: "NTC 温度", exact: true }),
  ).toBeChecked();
  await overflow
    .getByRole("checkbox", { name: "风扇转速", exact: true })
    .check();
  await more().click();
  await page.screenshot({ path: info.outputPath("fullscreen-parameters.png") });
  await toolbar.getByRole("button", { name: "退出" }).click();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await group().scrollIntoViewIfNeeded();
  await more().click();
  await expect(
    overflow.getByRole("checkbox", { name: "风扇转速", exact: true }),
  ).toBeChecked();
  await page.setViewportSize({ width: 1920, height: 1050 });
  await expect(more()).toBeHidden();
  await expect(overflow).toBeHidden();
  await expect(group().getByRole("checkbox")).toHaveCount(10);
  await expect(
    group().getByRole("checkbox", { name: "NTC 温度", exact: true }),
  ).toBeChecked();
});

for (const scale of [75, 100, 150]) {
  for (const count of [121, 20_001]) {
    test(`mouse chart zoom, pan and hover markers follow physical coordinates at ${scale}% scale with ${count} samples`, async ({
      page,
    }, info) => {
      await page.addInitScript((scale) => {
        localStorage.setItem("atorch-appearance", JSON.stringify({ scale }));
      }, scale);
      await fixture(page, { count });
      await page.locator(".trend-chart").scrollIntoViewIfNeeded();
      const before = await chartState(page);
      const box = (await page.locator(".trend-chart").boundingBox())!;
      const x =
        box.x +
        ((before.grid.left +
          (before.width - before.grid.right - before.grid.left) / 2) *
          box.width) /
          before.width;
      const y = box.y + ((before.grid.top + 60) * box.height) / before.height;
      await page.mouse.move(x, y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      await expect
        .poll(async () => {
          const { range } = await chartState(page);
          return range.endValue - range.startValue;
        })
        .toBeLessThan(before.range.endValue - before.range.startValue);
      const zoomed = await chartState(page);
      await page.mouse.down();
      await page.mouse.move(x + 50, y, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => (await chartState(page)).range.startValue)
        .toBeLessThan(zoomed.range.startValue);
      await page.mouse.move(x + 20, y + 10);
      await expect(page.locator(".curve-tooltip")).toBeVisible();
      const markers = page.locator(".chart-hover-marker");
      await expect(markers).toHaveCount(2);
      for (const marker of await markers.all()) {
        await expect(marker).toBeVisible();
        await expect(marker).toHaveCSS("border-radius", "50%");
      }
      await page.screenshot({ path: info.outputPath(`mouse-${scale}.png`) });
      await page.mouse.move(0, 0);
      await expect(markers).toHaveCount(0);
    });
  }
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
      await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), mode);
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
      await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), mode);
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
  await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), "elapsed");
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
    await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), mode);
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
    await page.getByRole("button", { name: "复原", exact: true }).click();
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
    await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), mode);
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
      rows[0].voltage.toFixed(3),
    );
    await expect(stats.getByRole("cell").nth(3)).toHaveText(
      rows.at(-1).voltage.toFixed(3),
    );
    await expect(
      page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
    ).toHaveCount(Math.min(10, rows.length));
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const csv = await page.evaluate(
      () =>
        (window as any).samplingFixture.calls.findLast(
          (c: any) => c.command === "save_csv",
        ).args.content as string,
    );
    expect(csv.trim().split(/\r?\n/).length - 1).toBe(rows.length);
    await page.getByRole("button", { name: "复原", exact: true }).click();
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

test("plain wheel scrolls the page over plot and axes, while Ctrl wheel zooms without browser scaling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await fixture(page);
  const shell = page.locator(".main-shell");
  expect(
    await shell.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeGreaterThan(0);
  const initial = await chartState(page);
  const points = [
    { x: initial.grid.left + 50, y: 100 },
    { x: initial.grid.left - 12, y: 100 },
    { x: initial.grid.left + 50, y: initial.height - 40 },
  ];
  for (const point of points) {
    await shell.evaluate((element) => {
      element.scrollTop = 0;
    });
    const state = await chartState(page);
    await page.mouse.move(state.left + point.x, state.top + point.y);
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => shell.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const after = await chartState(page);
    expect(after.axes).toEqual(initial.axes);
    expect(after.range).toEqual(initial.range);
  }
  await shell.evaluate((element) => {
    element.scrollTop = 0;
  });
  const state = await chartState(page);
  await page.mouse.move(state.left + initial.grid.left + 50, state.top + 100);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect
    .poll(
      async () =>
        (await chartState(page)).range.end -
        (await chartState(page)).range.start,
    )
    .toBeLessThan(100);
  expect(await shell.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
});

test.describe("damped chart touch zoom", () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 850 },
  });
  test("pinch follows finger distance instead of touch-event count and preserves page scale", async ({
    page,
  }, info) => {
    await fixture(page);
    await page.locator(".trend-chart").scrollIntoViewIfNeeded();
    const session = await page.context().newCDPSession(page);
    const resetRange = async () =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .find((url) => url.includes("/echarts_core.js"))!;
        const { getInstanceByDom } = await import(url);
        getInstanceByDom(document.querySelector(".trend-chart")).dispatchAction(
          { type: "dataZoom", start: 20, end: 80 },
        );
      });
    const spans: number[] = [];
    for (const moves of [2, 20]) {
      await resetRange();
      const before = await chartState(page);
      const x =
        before.left + (before.grid.left + before.width - before.grid.right) / 2;
      const y = before.top + 100;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { id: 0, x: x - 40, y },
          { id: 1, x: x + 40, y },
        ],
      });
      for (let index = 1; index <= moves; index++) {
        const half = 40 + (20 * index) / moves;
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { id: 0, x: x - half, y },
            { id: 1, x: x + half, y },
          ],
        });
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const after = await chartState(page);
      spans.push(after.range.endValue - after.range.startValue);
      expect(
        spans.at(-1)! / (before.range.endValue - before.range.startValue),
      ).toBeCloseTo(Math.sqrt(80 / 120), 3);
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    }
    expect(spans[1]).toBeCloseTo(spans[0], 3);
    await page.screenshot({ path: info.outputPath("damped-pinch.png") });
    await session.detach();
  });
});

type TouchPosition = { x: number; y: number; id: number };
async function touchInput(
  session: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
  touchPoints: TouchPosition[],
) {
  await session.send("Input.dispatchTouchEvent", { type, touchPoints });
}
function physicalTouch(
  state: Awaited<ReturnType<typeof chartState>>,
  x: number,
  y: number,
  id = 0,
): TouchPosition {
  return {
    id,
    x: state.rotated
      ? state.left + state.physicalWidth * (1 - y / state.height)
      : state.left + x * state.scaleX,
    y: state.rotated
      ? state.top + (x / state.width) * state.physicalHeight
      : state.top + y * state.scaleY,
  };
}
async function mobileChart(
  page: Page,
  options: Parameters<typeof fixture>[1] = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem("atorch-appearance", JSON.stringify({ scale: 75 }));
    localStorage.setItem("atorch-chart-height", "560");
    localStorage.setItem(
      "atorch-chart-bounds",
      JSON.stringify({
        voltage: { min: -10, max: 10 },
        current: { min: -5, max: 5 },
      }),
    );
  });
  await fixture(page, { stepVoltage: true, ...options });
  await page.locator(".trend-chart").scrollIntoViewIfNeeded();
}
function valueAxisX(
  state: Awaited<ReturnType<typeof chartState>>,
  index: number,
) {
  const axis = state.axes[index];
  return axis.position === "left"
    ? state.grid.left - axis.offset - 14
    : state.width - state.grid.right + axis.offset + 14;
}

test.describe("mobile axis and hold gestures", () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    viewport: { width: 393, height: 850 },
  });

  test("pinching each value axis isolates its unit, uses exact ticks and ignores touch-event frequency", async ({
    page,
  }, info) => {
    await mobileChart(page);
    const session = await page.context().newCDPSession(page);
    for (const axisIndex of [0, 1]) {
      const results: unknown[] = [];
      for (const moves of [2, 20]) {
        const reset = page.getByRole("button", {
          name: "复原",
          exact: true,
        });
        if (await reset.isEnabled()) await reset.click();
        await page.locator(".trend-chart").scrollIntoViewIfNeeded();
        const before = await chartState(page);
        const x = valueAxisX(before, axisIndex);
        const y = (before.grid.top + before.height - before.grid.bottom) / 2;
        const points = (half: number) => [
          physicalTouch(before, x, y - half, 0),
          physicalTouch(before, x, y + half, 1),
        ];
        await touchInput(session, "touchStart", points(30));
        for (let i = 1; i <= moves; i++)
          await touchInput(session, "touchMove", points(30 + (90 * i) / moves));
        await touchInput(session, "touchEnd", []);
        await expect
          .poll(async () => (await chartState(page)).axes[axisIndex].interval)
          .toBe(before.axes[axisIndex].interval / 2);
        const after = await chartState(page);
        results.push(after.axes);
        expect(after.axes[1 - axisIndex]).toEqual(before.axes[1 - axisIndex]);
        expect(after.range.startValue).toBe(before.range.startValue);
        expect(after.range.endValue).toBe(before.range.endValue);
        expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
        await expectExactAxisTicks(page);
      }
      expect(results[1]).toEqual(results[0]);
    }
    await page
      .locator(".chart-card")
      .screenshot({ path: info.outputPath("touch-value-pinch.png") });
    await session.detach();
  });

  test("holding the plot selects either direction across live updates and enforces the one-second minimum", async ({
    page,
  }, info) => {
    await mobileChart(page);
    const session = await page.context().newCDPSession(page);
    for (const reverse of [false, true]) {
      await zoom(page, 20, 80);
      const before = await chartState(page);
      const width = before.width - before.grid.left - before.grid.right;
      const y = before.grid.top + 100;
      const start = physicalTouch(
        before,
        before.grid.left + width * (reverse ? 0.7 : 0.2),
        y,
      );
      const end = physicalTouch(
        before,
        before.grid.left + width * (reverse ? 0.2 : 0.7),
        y + 15,
      );
      await touchInput(session, "touchStart", [start]);
      await expect(page.locator(".chart-range-selection")).toBeVisible();
      await page.evaluate(() => (window as any).samplingFixture.tick());
      await page.waitForTimeout(350);
      await touchInput(session, "touchMove", [end]);
      await expect(page.locator(".chart-range-selection")).toBeVisible();
      if (!reverse)
        await page
          .locator(".chart-card")
          .screenshot({ path: info.outputPath("touch-range-held.png") });
      await touchInput(session, "touchEnd", []);
      await expect(page.locator(".chart-range-selection")).toBeHidden();
      await expect
        .poll(async () => {
          const state = await chartState(page);
          return (
            (state.range.endValue - state.range.startValue) /
            (before.range.endValue - before.range.startValue)
          );
        })
        .toBeCloseTo(0.5, 2);
      expect((await chartState(page)).axes).toEqual(before.axes);
      expect(
        await page.locator("html").getAttribute("data-chart-dragging-cursor"),
      ).toBeNull();
    }
    await zoom(page, 40, 45);
    const before = await chartState(page);
    const x = (before.grid.left + before.width - before.grid.right) / 2;
    const start = physicalTouch(before, x, before.grid.top + 100);
    const end = physicalTouch(before, x + 6, before.grid.top + 100);
    await touchInput(session, "touchStart", [start]);
    await expect(page.locator(".chart-range-selection")).toBeVisible();
    await touchInput(session, "touchMove", [end]);
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => {
        const state = await chartState(page);
        return state.range.endValue - state.range.startValue;
      })
      .toBeCloseTo(1000, 4);
    await session.detach();
  });

  test("holding either value axis pans by its unchanged grid cells while live samples arrive", async ({
    page,
  }, info) => {
    await mobileChart(page);
    const session = await page.context().newCDPSession(page);
    for (const axisIndex of [0, 1]) {
      await zoom(page, 20, 80);
      const before = await chartState(page);
      const axis = before.axes[axisIndex];
      const x = valueAxisX(before, axisIndex);
      const cells = (axis.max - axis.min) / axis.interval;
      const cell =
        (before.height - before.grid.top - before.grid.bottom) / cells;
      const y = before.grid.top + cell * 3;
      await touchInput(session, "touchStart", [physicalTouch(before, x, y)]);
      await expect(page.locator("html")).toHaveAttribute(
        "data-chart-dragging-cursor",
        "ns-resize",
      );
      await touchInput(session, "touchMove", [
        physicalTouch(before, x, y + cell * 2),
      ]);
      await expect
        .poll(async () => (await chartState(page)).axes[axisIndex].min)
        .toBeCloseTo(axis.min + 2 * axis.interval, 6);
      await page.evaluate(() => (window as any).samplingFixture.tick());
      await page.waitForTimeout(350);
      await touchInput(session, "touchMove", [
        physicalTouch(before, x, y + cell),
      ]);
      await touchInput(session, "touchEnd", []);
      const after = await chartState(page);
      expect(after.axes[axisIndex].min).toBeCloseTo(
        axis.min + axis.interval,
        6,
      );
      expect(after.axes[axisIndex].max).toBeCloseTo(
        axis.max + axis.interval,
        6,
      );
      expect(after.axes[axisIndex].interval).toBe(axis.interval);
      expect(after.axes[1 - axisIndex]).toEqual(before.axes[1 - axisIndex]);
      expect(after.range.startValue).toBe(before.range.startValue);
      expect(after.range.endValue).toBe(before.range.endValue);
      expect(
        await page.locator("html").getAttribute("data-chart-dragging-cursor"),
      ).toBeNull();
    }
    await page
      .locator(".chart-card")
      .screenshot({ path: info.outputPath("touch-value-pan.png") });
    await session.detach();
  });

  test("moving before the hold cancels it, scrolls the page vertically and keeps ordinary horizontal pan", async ({
    page,
  }) => {
    await mobileChart(page);
    const session = await page.context().newCDPSession(page);
    const shell = page.locator(".main-shell");
    await shell.evaluate((element) => {
      element.scrollTop = 0;
    });
    const before = await chartState(page);
    const x = (before.grid.left + before.width - before.grid.right) / 2;
    const y = before.grid.top + 160;
    await touchInput(session, "touchStart", [physicalTouch(before, x, y)]);
    await touchInput(session, "touchMove", [physicalTouch(before, x, y - 60)]);
    await page.waitForTimeout(550);
    await expect(page.locator(".chart-range-selection")).toBeHidden();
    expect(
      await shell.evaluate((element) => element.scrollTop),
    ).toBeGreaterThan(0);
    await touchInput(session, "touchEnd", []);
    expect((await chartState(page)).range.startValue).toBe(
      before.range.startValue,
    );
    expect((await chartState(page)).axes).toEqual(before.axes);
    await zoom(page, 30, 70);
    await page.locator(".trend-chart").scrollIntoViewIfNeeded();
    const zoomed = await chartState(page);
    await touchInput(session, "touchStart", [physicalTouch(zoomed, x, y)]);
    await touchInput(session, "touchMove", [physicalTouch(zoomed, x + 40, y)]);
    await page.waitForTimeout(550);
    await expect(page.locator(".chart-range-selection")).toBeHidden();
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => (await chartState(page)).range.startValue)
      .toBeLessThan(zoomed.range.startValue);
    await session.detach();
  });

  test("a second finger, touch cancellation and unmount cancel the hold without committing a selection", async ({
    page,
  }) => {
    await mobileChart(page);
    const session = await page.context().newCDPSession(page);
    for (const cancel of ["second-finger", "touch-cancel", "window-blur"]) {
      const before = await chartState(page);
      const x = (before.grid.left + before.width - before.grid.right) / 2;
      const y = before.grid.top + 100;
      const start = physicalTouch(before, x, y);
      await touchInput(session, "touchStart", [start]);
      await expect(page.locator(".chart-range-selection")).toBeVisible();
      await touchInput(session, "touchMove", [
        physicalTouch(before, x + 50, y),
      ]);
      if (cancel === "second-finger") {
        await touchInput(session, "touchStart", [
          physicalTouch(before, x + 50, y),
          physicalTouch(before, x + 110, y, 1),
        ]);
        await expect(page.locator(".chart-range-selection")).toBeHidden();
        await touchInput(session, "touchEnd", []);
      } else if (cancel === "window-blur") {
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await touchInput(session, "touchEnd", []);
      } else await touchInput(session, "touchCancel", []);
      await expect(page.locator(".chart-range-selection")).toBeHidden();
      const after = await chartState(page);
      expect(after.range.startValue).toBe(before.range.startValue);
      expect(after.range.endValue).toBe(before.range.endValue);
      expect(after.axes).toEqual(before.axes);
      expect(
        await page.locator("html").getAttribute("data-chart-dragging-cursor"),
      ).toBeNull();
    }
    const state = await chartState(page);
    await touchInput(session, "touchStart", [
      physicalTouch(state, state.grid.left + 60, state.grid.top + 100),
    ]);
    await page
      .getByRole("button", { name: "应用设置", exact: true })
      .evaluate((element: HTMLElement) => element.click());
    await page.waitForTimeout(600);
    expect(
      await page.locator("html").getAttribute("data-chart-dragging-cursor"),
    ).toBeNull();
    await touchInput(session, "touchCancel", []);
    await session.detach();
  });

  test("rotated fullscreen maps touch axis pinch, hold-pan and range selection to chart coordinates", async ({
    page,
  }, info) => {
    await mobileChart(page);
    await page.getByRole("button", { name: "全屏", exact: true }).click();
    await expect(page.locator("dialog:modal")).toHaveClass(
      /chart-fullscreen-rotated/,
    );
    const session = await page.context().newCDPSession(page);
    const before = await chartState(page);
    const x = valueAxisX(before, 1);
    const y = (before.grid.top + before.height - before.grid.bottom) / 2;
    await touchInput(session, "touchStart", [
      physicalTouch(before, x, y - 30, 0),
      physicalTouch(before, x, y + 30, 1),
    ]);
    await touchInput(session, "touchMove", [
      physicalTouch(before, x, y - 120, 0),
      physicalTouch(before, x, y + 120, 1),
    ]);
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => (await chartState(page)).axes[1].interval)
      .toBe(before.axes[1].interval / 2);
    const pinched = await chartState(page);
    const axisX = valueAxisX(pinched, 1);
    const cells =
      (pinched.axes[1].max - pinched.axes[1].min) / pinched.axes[1].interval;
    const cell =
      (pinched.height - pinched.grid.top - pinched.grid.bottom) / cells;
    await touchInput(session, "touchStart", [physicalTouch(pinched, axisX, y)]);
    await expect(page.locator("html")).toHaveAttribute(
      "data-chart-dragging-cursor",
      "ns-resize",
    );
    await touchInput(session, "touchMove", [
      physicalTouch(pinched, axisX, y + cell),
    ]);
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => (await chartState(page)).axes[1].min)
      .toBeCloseTo(pinched.axes[1].min + pinched.axes[1].interval, 6);
    const panned = await chartState(page);
    const width = panned.width - panned.grid.left - panned.grid.right;
    await touchInput(session, "touchStart", [
      physicalTouch(panned, panned.grid.left + width * 0.2, y),
    ]);
    await expect(page.locator(".chart-range-selection")).toBeVisible();
    await touchInput(session, "touchMove", [
      physicalTouch(panned, panned.grid.left + width * 0.7, y),
    ]);
    await page.screenshot({
      path: info.outputPath("rotated-touch-selection.png"),
    });
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => {
        const state = await chartState(page);
        return (
          (state.range.endValue - state.range.startValue) /
          (panned.range.endValue - panned.range.startValue)
        );
      })
      .toBeCloseTo(0.5, 2);
    expect((await chartState(page)).axes).toEqual(panned.axes);
    const selected = await chartState(page);
    const start = physicalTouch(selected, selected.grid.left + width * 0.5, y);
    const end = physicalTouch(selected, selected.grid.left + width * 0.6, y);
    await touchInput(session, "touchStart", [start]);
    await touchInput(session, "touchMove", [end]);
    await touchInput(session, "touchEnd", []);
    await expect
      .poll(async () => (await chartState(page)).range.startValue)
      .toBeLessThan(selected.range.startValue);
    expect((await chartState(page)).axes).toEqual(selected.axes);
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
    await session.detach();
  });

  for (const emptyCurves of [false, true]) {
    test(`empty touch charts reject pinch and hold gestures (${emptyCurves ? "missing values" : "no samples"})`, async ({
      page,
    }) => {
      await mobileChart(
        page,
        emptyCurves ? { emptyCurves: true } : { count: 0 },
      );
      const session = await page.context().newCDPSession(page);
      const before = await chartState(page);
      const x = (before.grid.left + before.width - before.grid.right) / 2;
      const y = before.grid.top + 100;
      await touchInput(session, "touchStart", [physicalTouch(before, x, y)]);
      await page.waitForTimeout(550);
      await touchInput(session, "touchMove", [
        physicalTouch(before, x + 60, y),
      ]);
      await touchInput(session, "touchEnd", []);
      await expect(page.locator(".chart-range-selection")).toBeHidden();
      await touchInput(session, "touchStart", [
        physicalTouch(before, x - 30, y, 0),
        physicalTouch(before, x + 30, y, 1),
      ]);
      await touchInput(session, "touchMove", [
        physicalTouch(before, x - 100, y, 0),
        physicalTouch(before, x + 100, y, 1),
      ]);
      await touchInput(session, "touchEnd", []);
      const after = await chartState(page);
      expect(after.range).toEqual(before.range);
      expect(after.axes).toEqual(before.axes);
      expect(
        await page.locator("html").getAttribute("data-chart-dragging-cursor"),
      ).toBeNull();
      await session.detach();
    });
  }
});

test("wheel over each unit axis respects exact tick limits, isolates that axis and reset restores all axes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1100 });
  await fixture(page);
  for (const name of [
    "功率",
    "电阻",
    "电量",
    "容量",
    "CPU 温度",
    "NTC 温度",
    "MOS 温度",
    "风扇转速",
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
    await page.keyboard.down("Control");
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(25);
    }
    const expanded = await chartState(page);
    expect(
      expanded.axes[index].max - expanded.axes[index].min,
    ).toBeGreaterThanOrEqual(axis.max - axis.min);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(25);
    }
    await page.keyboard.up("Control");
    const after = await chartState(page);
    expect(after.axes[index].max - after.axes[index].min).toBeLessThanOrEqual(
      expanded.axes[index].max - expanded.axes[index].min,
    );
    await expect(
      page.getByRole("button", { name: "复原", exact: true }),
    ).toBeEnabled();
    await expectExactAxisTicks(page);
    for (let other = 0; other < after.axes.length; other++)
      if (other !== index)
        expect(
          after.axes[other],
          JSON.stringify({ index, before: before.axes, after: after.axes }),
        ).toMatchObject({
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
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect
    .poll(
      async () =>
        (await chartState(page)).range.end -
        (await chartState(page)).range.start,
    )
    .toBeLessThan(100);
  const afterTime = await chartState(page);
  expect(afterTime.axes).toEqual(state.axes);
  await page.getByRole("button", { name: "复原", exact: true }).click();
  await expect
    .poll(async () => (await chartState(page)).axes)
    .toEqual(initial.axes);
  expect((await chartState(page)).range.end).toBe(100);
  await expect(
    page.getByRole("button", { name: "复原", exact: true }),
  ).toBeDisabled();
});

test("a single value-axis wheel notch changes a legal scale immediately, including after a limit", async ({
  page,
}) => {
  await fixture(page);
  const initial = await chartState(page);
  const point = {
    x: initial.left + (initial.grid.left - 12) * initial.scaleX,
    y: initial.top + 110 * initial.scaleY,
  };
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down("Control");
  const span = async () => {
    const axis = (await chartState(page)).axes[0];
    return axis.max - axis.min;
  };
  const originalSpan = await span();
  await page.mouse.wheel(0, 120);
  await expect.poll(span).toBeGreaterThan(originalSpan);
  const expanded = await span();
  await page.mouse.wheel(0, -120);
  await expect.poll(span).toBeLessThan(expanded);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
  const limit = await span();
  await page.mouse.wheel(0, 120);
  await expect.poll(span).toBeGreaterThan(limit);
  await page.keyboard.up("Control");
  await expectExactAxisTicks(page);
  const after = await chartState(page);
  expect(after.axes[1]).toEqual(initial.axes[1]);
  expect(after.range.startValue).toBe(initial.range.startValue);
  expect(after.range.endValue).toBe(initial.range.endValue);
});

for (const target of ["live", "history", "fullscreen"] as const) {
  test(`Ctrl drag selects only the horizontal range in ${target}, with a crosshair and live refresh`, async ({
    page,
  }) => {
    const scale = target === "live" ? 75 : 100;
    await page.addInitScript(
      (scale) =>
        localStorage.setItem("atorch-appearance", JSON.stringify({ scale })),
      scale,
    );
    await fixture(page);
    if (target === "history")
      await page.getByRole("button", { name: "数据记录", exact: true }).click();
    if (target === "fullscreen")
      await page.getByRole("button", { name: "全屏", exact: true }).click();
    await zoom(page, 20, 80);
    const before = await chartState(page);
    const width = before.width - before.grid.left - before.grid.right;
    const a = target === "fullscreen" ? 0.7 : 0.2;
    const b = target === "fullscreen" ? 0.2 : 0.7;
    const start = {
      x: before.left + (before.grid.left + width * a) * before.scaleX,
      y: before.top + (before.grid.top + 45) * before.scaleY,
    };
    const finish = {
      x: before.left + (before.grid.left + width * b) * before.scaleX,
      y: start.y + 30 * before.scaleY,
    };
    await page.mouse.move(start.x, start.y);
    await page.keyboard.down("Control");
    await expect(page.locator(".trend-chart canvas")).toHaveCSS(
      "cursor",
      "crosshair",
    );
    await page.mouse.down();
    await page.mouse.move((start.x + finish.x) / 2, start.y, { steps: 6 });
    await expect(page.locator(".chart-range-selection")).toBeVisible();
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await page.waitForTimeout(350);
    await page.mouse.move(finish.x, finish.y, { steps: 6 });
    const during = await chartState(page);
    expect(during.range.startValue).toBe(before.range.startValue);
    expect(during.range.endValue).toBe(before.range.endValue);
    await page
      .locator(".chart-scroll")
      .screenshot({ path: test.info().outputPath(`brush-${target}.png`) });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect(page.locator(".chart-range-selection")).toBeHidden();
    const span = before.range.endValue - before.range.startValue;
    await expect
      .poll(async () => (await chartState(page)).range.startValue)
      .toBeCloseTo(before.range.startValue + span * 0.2, -1);
    await expect
      .poll(async () => (await chartState(page)).range.endValue)
      .toBeCloseTo(before.range.startValue + span * 0.7, -1);
    const after = await chartState(page);
    expect(after.axes).toEqual(before.axes);
  });
}

test("Ctrl range selection cancels without changing the range and the slider has no crosshair or brush", async ({
  page,
}) => {
  await fixture(page);
  await zoom(page, 20, 80);
  const before = await chartState(page);
  const width = before.width - before.grid.left - before.grid.right;
  const y = before.top + 100;
  await page.mouse.move(before.left + before.grid.left + width * 0.25, y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(before.left + before.grid.left + width * 0.65, y, {
    steps: 6,
  });
  await expect(page.locator(".chart-range-selection")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".chart-range-selection")).toBeHidden();
  expect((await chartState(page)).range.startValue).toBe(
    before.range.startValue,
  );
  expect((await chartState(page)).range.endValue).toBe(before.range.endValue);
  const slider = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const chart = getInstanceByDom(document.querySelector(".trend-chart"));
    const option = chart.getOption();
    return {
      brush: option.dataZoom[1].brushSelect,
      gap:
        option.grid[0].bottom -
        option.dataZoom[1].bottom -
        option.dataZoom[1].height,
    };
  });
  expect(slider.brush).toBe(false);
  expect(slider.gap).toBe(26);
  await page.mouse.move(
    before.left + before.grid.left + width * 0.07,
    before.top + before.height - 9,
  );
  await expect(page.locator(".trend-chart canvas")).not.toHaveCSS(
    "cursor",
    "crosshair",
  );
  await page.mouse.down();
  await page.mouse.move(
    before.left + before.grid.left + width * 0.15,
    before.top + before.height - 9,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect
    .poll(async () => {
      const range = (await chartState(page)).range;
      return range.end - range.start;
    })
    .toBeCloseTo(before.range.end - before.range.start, 4);
  await expect(page.locator(".chart-range-selection")).toBeHidden();
});

test("panning crosses the ten-value boundary at the current scale and locks its cursor until release", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atorch-chart-height", "560");
    localStorage.setItem(
      "atorch-chart-bounds",
      JSON.stringify({ voltage: { min: -10, max: 10 } }),
    );
  });
  await fixture(page, { stepVoltage: true });
  await page.locator(".trend-chart").scrollIntoViewIfNeeded();
  const before = await chartState(page);
  expect(before.axes[0]).toMatchObject({ min: -10, max: 10, interval: 2 });
  const cell = (before.height - before.grid.top - before.grid.bottom) / 10;
  const x = before.left + before.grid.left - 14;
  const y = before.top + before.grid.top + cell * 3;
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(x, y + cell, { steps: 8 });
  await expect.poll(async () => (await chartState(page)).axes[0].min).toBe(-8);
  expect((await chartState(page)).axes[0]).toMatchObject({
    max: 12,
    interval: 2,
  });
  await page.keyboard.up("Control");
  await page.mouse.move(30, y + cell);
  await expect(page.locator("body")).toHaveCSS("cursor", "ns-resize");
  await page.evaluate(() => (window as any).samplingFixture.tick());
  await page.waitForTimeout(350);
  await expect(page.locator("body")).toHaveCSS("cursor", "ns-resize");
  await page.mouse.up();
  expect(
    await page.locator("html").getAttribute("data-chart-dragging-cursor"),
  ).toBeNull();
  const ticks = (await exactAxisTicks(page)).axes[0].ticks;
  expect(ticks.at(-1).value).toBe(12);
  expect(
    ticks.every(
      (tick: any) => Number(tick.label.replace(/ V$/, "")) === tick.value,
    ),
  ).toBe(true);
  expect((await chartState(page)).axes[1]).toEqual(before.axes[1]);
  await page
    .locator(".chart-scroll")
    .screenshot({ path: test.info().outputPath("panned-past-ten.png") });
});

test("vertical pan and zoom retain an original point and reverse immediately from the pan boundary", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("atorch-chart-height", "560");
    localStorage.setItem(
      "atorch-chart-bounds",
      JSON.stringify({ voltage: { min: -10, max: 10 } }),
    );
  });
  await fixture(page, { stepVoltage: true });
  await page.locator(".trend-chart").scrollIntoViewIfNeeded();
  const before = await chartState(page);
  const cell = (before.height - before.grid.top - before.grid.bottom) / 10;
  const x = before.left + before.grid.left - 14;
  const y = before.top + before.grid.top + cell * 2;
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(x, y + cell * 20, { steps: 12 });
  await expect.poll(async () => (await chartState(page)).axes[0].min).toBe(4);
  await page.mouse.move(x, y + cell * 19, { steps: 4 });
  await expect.poll(async () => (await chartState(page)).axes[0].min).toBe(2);
  await page.mouse.up();
  const afterPan = await chartState(page);
  await page.mouse.move(
    afterPan.left + afterPan.grid.left - 14,
    afterPan.top + afterPan.grid.top + 30,
  );
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(35);
    const state = await chartState(page);
    const axis = state.axes[0];
    expect(
      state.rows.some(
        (row: any) => row.voltage >= axis.min && row.voltage <= axis.max,
      ),
    ).toBe(true);
  }
  await page.keyboard.up("Control");
});

for (const emptyCurves of [false, true]) {
  test(`empty curve data disables plot, axes and slider input (${emptyCurves ? "missing selected values" : "no samples"})`, async ({
    page,
  }) => {
    await fixture(page, { count: emptyCurves ? 10 : 0, emptyCurves });
    const before = await chartState(page);
    for (const [x, y] of [
      [before.grid.left + 60, 100],
      [before.grid.left - 14, 100],
      [before.grid.left + 60, before.height - 9],
    ]) {
      await page.mouse.move(before.left + x, before.top + y);
      await expect(page.locator(".trend-chart canvas")).toHaveCSS(
        "cursor",
        "not-allowed",
      );
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.mouse.down();
      await page.mouse.move(before.left + x + 60, before.top + y + 20, {
        steps: 6,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const after = await chartState(page);
      expect(after.axes).toEqual(before.axes);
      expect(after.range.startValue).toBe(before.range.startValue);
      expect(after.range.endValue).toBe(before.range.endValue);
      await expect(page.locator(".chart-range-selection")).toBeHidden();
    }
    expect(
      await page.locator("html").getAttribute("data-chart-dragging-cursor"),
    ).toBeNull();
    if (emptyCurves) {
      await page.getByRole("checkbox", { name: "功率", exact: true }).check();
      await page.mouse.move(
        before.left + before.grid.left + 60,
        before.top + 100,
      );
      await expect(page.locator(".trend-chart canvas")).not.toHaveCSS(
        "cursor",
        "not-allowed",
      );
    }
  });
}

test("horizontal ranges allow empty time periods but wheel, box and slider enforce one second", async ({
  page,
}) => {
  await fixture(page, { gap: true });
  const setGapRange = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => url.includes("/echarts_core.js"))!;
      const { getInstanceByDom } = await import(url);
      const chart = getInstanceByDom(document.querySelector(".trend-chart"));
      const base = (window as any).samplingFixture.rows[0].timestamp;
      chart.dispatchAction({
        type: "dataZoom",
        startValue: base + 80_000,
        endValue: base + 90_000,
      });
    });
  await setGapRange();
  const before = await chartState(page);
  const x =
    before.left + (before.grid.left + before.width - before.grid.right) / 2;
  const y = before.top + 100;
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  for (let i = 0; i < 25; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(15);
  }
  const span = async () => {
    const state = await chartState(page);
    return state.range.endValue - state.range.startValue;
  };
  await expect.poll(span).toBeCloseTo(1000, 4);
  const range = (await chartState(page)).range;
  expect(
    before.rows.some(
      (row: any) =>
        row.timestamp >= range.startValue && row.timestamp <= range.endValue,
    ),
  ).toBe(false);
  await setGapRange();
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 5, { steps: 4 });
  await page.keyboard.up("Control");
  await expect(page.locator("body")).toHaveCSS("cursor", "crosshair");
  await page.mouse.up();
  await expect.poll(span).toBeCloseTo(1000, 4);
  await zoom(page, 20, 80);
  await page.locator(".trend-chart").scrollIntoViewIfNeeded();
  const handles = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    const element = document.querySelector(".trend-chart")!;
    const chart = getInstanceByDom(element);
    const view = chart.getViewOfComponentModel(
      chart.getModel().getComponent("dataZoom", 1),
    );
    const box = element.getBoundingClientRect();
    return view._displayables.handles.map((handle: any) => {
      const rect = handle.getBoundingRect();
      const [x, y] = handle.transformCoordToGlobal(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return {
        x: box.left + (x * box.width) / chart.getWidth(),
        y: box.top + (y * box.height) / chart.getHeight(),
      };
    });
  });
  await page.mouse.move(handles[0].x, handles[0].y);
  await page.mouse.down();
  await page.mouse.move(handles[1].x - 1, handles[1].y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(span).toBeCloseTo(1000, 2);
});

for (const count of [1, 121]) {
  test(`the newest sample stays exactly at the right edge in both time modes (${count} samples)`, async ({
    page,
  }, info) => {
    await fixture(page, { count });
    await page.evaluate(() => {
      (window as any).samplingFixture.elapsedAdvance = 500;
    });
    for (const mode of ["clock", "elapsed"]) {
      await chooseMenu(page.getByLabel("曲线时间坐标", { exact: true }), mode);
      const inspect = () =>
        page.evaluate(async (mode) => {
          const url = performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .find((url) => url.includes("/echarts_core.js"))!;
          const { getInstanceByDom } = await import(url);
          const chart = getInstanceByDom(
            document.querySelector(".trend-chart"),
          );
          const row = (window as any).samplingFixture.rows.at(-1);
          const time = mode === "clock" ? row.timestamp : row.elapsedMs;
          const grid = chart
            .getModel()
            .getComponent("grid")
            .coordinateSystem.getRect();
          return {
            difference:
              chart.convertToPixel({ xAxisIndex: 0 }, time) -
              (grid.x + grid.width),
            time,
            max: chart.getOption().xAxis[0].max,
          };
        }, mode);
      await expect
        .poll(async () => (await inspect()).difference)
        .toBeCloseTo(0, 6);
      await page.waitForTimeout(350);
      expect((await inspect()).max).toBe((await inspect()).time);
      await page.evaluate(() => (window as any).samplingFixture.tick());
      await expect
        .poll(async () => (await inspect()).difference)
        .toBeCloseTo(0, 6);
      await page.locator(".chart-card").screenshot({
        path: info.outputPath(`latest-at-right-${mode}.png`),
      });
    }
  });
}

test("Ctrl vertical-axis drag pans each side by exact grid cells while preserving scale and time", async ({
  page,
}) => {
  await fixture(page);
  const shell = page.locator(".main-shell");
  for (const index of [0, 1]) {
    await zoom(page, 20, 80);
    const before = await chartState(page);
    const axis = before.axes[index];
    const x =
      axis.position === "left"
        ? before.grid.left - axis.offset - 14
        : before.width - before.grid.right + axis.offset + 14;
    const cells = (axis.max - axis.min) / axis.interval;
    const cellHeight =
      (before.height - before.grid.bottom - before.grid.top) / cells;
    const startY = before.grid.top + cellHeight * 1.3;
    const scroll = await shell.evaluate((el) => el.scrollTop);
    await page.mouse.move(before.left + x, before.top + startY);
    await page.keyboard.down("Control");
    await expect(page.locator(".trend-chart canvas")).toHaveCSS(
      "cursor",
      "ns-resize",
    );
    await page.mouse.down();
    await page.mouse.move(
      before.left + x,
      before.top + startY + cellHeight * 2,
      { steps: 12 },
    );
    await expect
      .poll(async () => (await chartState(page)).axes[index].min)
      .toBeCloseTo(axis.min + 2 * axis.interval, 7);
    await page.evaluate(() => (window as any).samplingFixture.tick());
    await page.waitForTimeout(350);
    const during = await chartState(page);
    expect(during.axes[index].max - during.axes[index].min).toBeCloseTo(
      axis.max - axis.min,
      8,
    );
    await page.mouse.up();
    await page.keyboard.up("Control");
    const after = await chartState(page);
    expect(after.axes[index].interval).toBe(axis.interval);
    expect(after.axes[1 - index]).toEqual(before.axes[1 - index]);
    expect(after.range.startValue).toBe(before.range.startValue);
    expect(after.range.endValue).toBe(before.range.endValue);
    expect(await shell.evaluate((el) => el.scrollTop)).toBe(scroll);
    await expectExactAxisTicks(page);
    await page.getByRole("button", { name: "复原", exact: true }).click();
  }
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
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "复原", exact: true }).click();
  await expect(row.getByRole("cell").nth(1)).toHaveText("4");
});

test("export and screenshot stay on the left, with reset and fullscreen at the lower right on both pages", async ({
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
        ? ["导出", "截图", "复原", "全屏"]
        : ["暂停", "清空", "导出", "截图", "复原", "全屏"],
    );
    const exported = await footer
      .getByRole("button", { name: history ? "导出" : "导出", exact: true })
      .boundingBox();
    const image = await footer
      .getByRole("button", { name: "截图", exact: true })
      .boundingBox();
    const reset = await footer
      .getByRole("button", { name: "复原", exact: true })
      .boundingBox();
    expect(image!.x).toBeGreaterThan(exported!.x + exported!.width);
    expect(image!.height).toBe(exported!.height);
    expect(reset!.height).toBe(exported!.height);
    expect(image!.x - exported!.x - exported!.width).toBeLessThanOrEqual(9);
    expect(reset!.x).toBeGreaterThan(image!.x + image!.width + 30);
    expect(
      await page
        .locator(".section-head")
        .getByRole("button", { name: "导出", exact: true })
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
      .getByRole("button", { name: "复原", exact: true })
      .boundingBox();
    const fullBox = await footer
      .getByRole("button", { name: "全屏", exact: true })
      .boundingBox();
    const mobileExport = await footer
      .getByRole("button", { name: history ? "导出" : "导出", exact: true })
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
    expect(fullBox!.x + fullBox!.width).toBeCloseTo(
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
