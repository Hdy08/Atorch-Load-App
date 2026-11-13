import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  options: {
    mode?: number;
    code?: number;
    fail?: boolean;
    result?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ mode = 7, code = 32, fail = false, result = false }) => {
      const calls: any[] = [];
      let prompt: any = {
        context: { status: 8, code },
        kind: Math.floor(code / 10),
        selection: code % 10,
        actions:
          Math.floor(code / 10) === 2
            ? [
                { value: 1, label: "返回", clearsData: false },
                {
                  value: 2,
                  label: "清除数据并开始新一轮放电",
                  clearsData: true,
                },
                { value: 5, label: "确认", clearsData: false },
              ]
            : Math.floor(code / 10) === 3
              ? [
                  { value: 1, label: "返回", clearsData: false },
                  { value: 2, label: "继续上一轮放电", clearsData: false },
                  {
                    value: 3,
                    label: "清除数据并开始新一轮放电",
                    clearsData: true,
                  },
                  { value: 5, label: "确认", clearsData: false },
                ]
              : [],
      };
      let running = false;
      const reading = () => ({
        mode,
        timestamp: Date.now(),
        running,
        status: prompt ? 8 : 0,
        stageCode: prompt ? code : 0,
        prompt,
        voltage: 12.5,
        current: -1.2,
        power: 15,
        resistance: 0.042,
        energy: 0,
        capacity: 1234,
      });
      Object.assign(window, {
        isTauri: true,
        specialCalls: calls,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            if (command === "get_snapshot")
              return {
                connected: true,
                device: { name: "BW150", serial: "test", transport: "usb" },
                settings: {
                  mode,
                  target: 1,
                  cutoffVoltage: 3,
                  fullVoltage: 4.2,
                  cutoffCurrent: 0.05,
                  limitHours: 0,
                  limitMinutes: 0,
                },
                telemetry: reading(),
                specialTest: {
                  reading: reading(),
                  startedAt: null,
                  observedStart: false,
                  peakPower: null,
                  peakCurrent: null,
                },
                specialResults: result
                  ? [
                      {
                        mode: 4,
                        startedAt: null,
                        stoppedAt: 1000,
                        observedStart: false,
                        peakPower: 15,
                        peakCurrent: 1.2,
                        lastRunning: { ...reading(), running: true },
                        stopped: {
                          ...reading(),
                          running: false,
                          resistance: 0,
                          energy: null,
                        },
                      },
                    ]
                  : [],
                sampleCount: 1,
                connectedAt: Date.now(),
                lastReportAt: Date.now(),
                recording: null,
                error: null,
                logs: [],
              };
            if (command === "get_history") return [];
            if (command === "send_command") {
              calls.push(args.command);
              if (fail) throw Error("设备阶段提示已变化，请核对后重新选择");
              prompt = null;
              running = args.command.value === 2 || args.command.value === 3;
              return;
            }
            if (command === "save_csv") {
              calls.push({ saved: args });
              return "test.csv";
            }
            if (command === "discover_devices") return [];
            if (command === "get_usb_diagnostics") return null;
            throw Error(`Unexpected command ${command}`);
          },
        },
      });
    },
    options,
  );
  await page.goto("/");
  await expect(page.getByTestId("special-test")).toBeVisible();
}

test("new discharge asks for explicit confirmation and sends the captured prompt", async ({
  page,
}) => {
  await fixture(page);
  await expect(
    page.getByRole("button", { name: "请先处理阶段选择", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "清除数据并开始新一轮放电", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "设备将清除数据并启动新一轮放电",
  );
  expect(await page.evaluate(() => (window as any).specialCalls)).toEqual([]);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => (window as any).specialCalls)).toEqual([]);
  await page
    .getByRole("button", { name: "清除数据并开始新一轮放电", exact: true })
    .click();
  await page.getByRole("button", { name: "确认阶段操作", exact: true }).click();
  await expect(page.getByTestId("stage-prompt")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).specialCalls)).toEqual([
    {
      kind: "stage",
      value: 3,
      expectedMode: 7,
      expectedPrompt: { status: 8, code: 32 },
    },
  ]);
  await expect(
    page.getByRole("button", { name: "停止负载", exact: true }),
  ).toBeEnabled();
});

test("kind 2 exposes only new discharge and kind 3 adds resume", async ({
  page,
}) => {
  await fixture(page, { code: 21 });
  await expect(
    page.getByRole("button", { name: "继续上一轮放电", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "清除数据并开始新一轮放电", exact: true })
    .click();
  await page.getByRole("button", { name: "确认阶段操作", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).specialCalls[0]?.value))
    .toBe(2);
});

test("changed prompt fails without optimistic dismissal and remains reviewable", async ({
  page,
}) => {
  await fixture(page, { fail: true });
  await page
    .getByRole("button", { name: "继续上一轮放电", exact: true })
    .click();
  await page.getByRole("button", { name: "确认阶段操作", exact: true }).click();
  await expect(page.getByText(/设备阶段提示已变化/)).toBeVisible();
  await expect(page.getByTestId("stage-prompt")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "继续上一轮放电", exact: true }),
  ).toBeEnabled();
});

test("unknown prompt does not guess actions or charge phase", async ({
  page,
}) => {
  await fixture(page, { code: 91 });
  await expect(page.getByTestId("stage-prompt")).toContainText(
    "暂未核准此提示的操作",
  );
  await expect(
    page.getByTestId("stage-prompt").getByRole("button"),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).specialCalls)).toEqual([]);
});

test("dedicated readings and CSV preserve zero, unknowns and mid-test connection", async ({
  page,
}) => {
  await fixture(page, { result: true });
  await expect(page.getByText("0.042 Ω", { exact: true })).toBeVisible();
  await expect(page.getByText(/连接时已在运行，记录不完整/)).toBeVisible();
  await page.getByRole("button", { name: "导出结果 CSV", exact: true }).click();
  const saved = await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).specialCalls.find((c: any) => c.saved)?.saved.content,
      ),
    )
    .toBeTruthy();
  const csv = await page.evaluate(
    () =>
      (window as any).specialCalls.find((c: any) => c.saved).saved
        .content as string,
  );
  expect(csv).toContain("STOP_RESISTANCE(Ω)");
  expect(csv).toContain(",0,,1234,8,32");
  expect(csv).toContain("IR,,1000,false");
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: "artifacts/special-controls-ui.png",
    fullPage: true,
  });
});
