import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  fail = false,
  hardware = false,
  recording = false,
  iap = false,
  deviceName = "",
) {
  await page.addInitScript(
    ({ fail, hardware, recording, iap, deviceName }) => {
      const calls: any[] = [];
      const device = {
        path: "test-usb-path",
        name:
          deviceName || (iap ? "ATORCH BW150 V1.0.2" : "ATORCH BW150 V1.1.0"),
        serial: "924415",
        transport: "usb",
      };
      Object.assign(window, {
        isTauri: true,
        firmwareCalls: calls,
        firmwareJob: null,
        firmwareRecordingPaused: false,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            calls.push({ command, args });
            if (command === "set_window_theme") return false;
            if (command === "open_firmware_log") {
              if ((window as any).firmwareLogError)
                throw Error("无法打开传输日志");
              return;
            }
            if (command === "get_snapshot")
              return {
                connected: !iap,
                device: iap ? null : device,
                settings: null,
                telemetry: (window as any).firmwareRecordingPaused
                  ? { running: false }
                  : null,
                sampleCount: 0,
                connectedAt: 0,
                lastReportAt: 0,
                recording: recording ? "test-recording.csv" : null,
                recordingPaused: (window as any).firmwareRecordingPaused,
                firmware: (window as any).firmwareJob,
                error: null,
                logs: [],
              };
            if (command === "get_history") return [];
            if (command === "discover_devices")
              return hardware
                ? ((window as any).firmwareDevices ?? [device])
                : [];
            if (command === "get_usb_diagnostics") return null;
            if (command === "inspect_firmware") {
              if (fail) throw Error("固件编码无效");
              return {
                name: args.name,
                bytes: 116,
                sha256: "a".repeat(64),
                crc16: "4B37",
                family: "二进制固件",
                filenameModel: args.name.startsWith("BW600")
                  ? "BW600"
                  : "BW150",
                blocks: 2,
                lastBlockBytes: 58,
                remainder: 0,
                handshakeHex: "AA 07 02 00 00 3C 00",
                firstBlockHex: "CC 40 00 00",
                lastBlockHex: "CC 40 01 00",
                bootEntryHex: "55 05 09 02 00 00 00 EE FF",
                hardwareWriteAvailable: hardware,
                limitation: hardware ? "" : "此平台仅支持离线预演",
              };
            }
            if (command === "start_firmware") {
              (window as any).firmwareJob = {
                active: true,
                cancellable: true,
                phase: "transferring",
                acknowledgedBlocks: 1,
                blocks: 2,
                bytes: 116,
                sha256: "a".repeat(64),
                message: "已确认 1 / 2 块",
                startedAt: Date.now(),
                finishedAt: null,
                logPath: "C:/test/firmware.jsonl",
                flashConfirmed: false,
                restoredDevice: null,
              };
              return;
            }
            if (command === "cancel_firmware") {
              Object.assign((window as any).firmwareJob, {
                active: false,
                cancellable: false,
                phase: "cancelled",
                message: "设备保留在 IAP，可重新选择固件恢复",
              });
              return;
            }
            if (command === "rehearse_firmware")
              return {
                offline: true,
                phase: "complete",
                blocks: 2,
                acknowledgedBlocks: 2,
                transferredBytes: 116,
                events: [
                  "AA 握手",
                  "BB 就绪",
                  "CC / DD 分块",
                  "EE 等待烧写",
                  "FF 完成（模拟）",
                ],
              };
            throw Error(`Unexpected command ${command}`);
          },
        },
      });
    },
    { fail, hardware, recording, iap, deviceName },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  await page.getByRole("tab", { name: "固件更新", exact: true }).click();
}
const file = (name = "BW150-test.bin") => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.alloc(116, 0x5a),
});

test("the USB card appears only after inspection and keeps refresh and flash beside the device selector", async ({
  page,
}) => {
  await fixture(page, false, true);
  await expect(page.locator(".firmware-status")).toHaveCount(0);
  await expect(page.locator(".firmware-layout > .fui-Card")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("firmware-input").setInputFiles(file());
  const card = page.locator(".firmware-status");
  await expect(
    card.getByRole("heading", { name: "选择 USB 设备", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText(/USB 升级与恢复|设备在线|等待连接|^序列号/),
  ).toHaveCount(0);
  await expect(card.locator(".fui-Badge")).toHaveCount(0);
  for (const width of [393, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // Read the three controls in one layout frame while responsive navigation changes.
    const { selector, refresh, flash } = await card.evaluate((element) => {
      const controls = element.querySelector(".firmware-device-controls")!;
      const [refresh, flash] = controls.querySelectorAll(
        "button:not(.menu-select)",
      );
      return {
        selector: controls
          .querySelector(".menu-select")!
          .getBoundingClientRect()
          .toJSON(),
        refresh: refresh.getBoundingClientRect().toJSON(),
        flash: flash.getBoundingClientRect().toJSON(),
      };
    });
    expect(Math.abs(selector.y - refresh.y)).toBeLessThan(1);
    expect(Math.abs(selector.y - flash.y)).toBeLessThan(1);
    expect(refresh.x).toBeGreaterThanOrEqual(selector.x + selector.width);
    expect(flash.x).toBeGreaterThanOrEqual(refresh.x + refresh.width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await card.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await card.getByRole("button", { name: "刷写", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("BW150-test.bin");
  await expect(dialog).not.toContainText(
    /从第 0|请保持供电|应用态设备会先进入/,
  );
  await dialog.getByRole("button", { name: "返回", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (call: any) => call.command === "start_firmware",
      ),
    ),
  ).toHaveLength(0);
});

test("an unselected USB target is a prompt, with only devices in the menu", async ({
  page,
}) => {
  await fixture(page, false, true, false, true, "ATORCH DL24 V1.1.0");
  await page.evaluate(() => {
    (window as any).firmwareDevices = [
      { path: "test-usb-path", name: "ATORCH DL24 V1.1.0", serial: "924415" },
      { path: "other-usb-path", name: "ATORCH BW150 V1.1.0", serial: "123456" },
    ];
  });
  await page.getByTestId("firmware-input").setInputFiles(file("DL24.bin"));
  const selector = page.getByRole("button", {
    name: "升级 USB 设备",
    exact: true,
  });
  await expect(selector).toHaveText("请选择 USB 设备");
  await expect(
    page.getByRole("button", { name: "刷写", exact: true }),
  ).toBeDisabled();
  await selector.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await page.getByRole("menuitemradio", { name: /ATORCH DL24/ }).click();
  await expect(selector).toHaveText("ATORCH DL24 V1.1.0 · 924415");
  await expect(
    page.getByRole("button", { name: "刷写", exact: true }),
  ).toBeEnabled();
});

test("firmware status has four full-width rows and its log button opens the native job file", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("atorch-theme", "dark"));
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  const job = page.getByTestId("firmware-job");
  await expect(job).toContainText("50% 1/2");
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      blocks: 3,
      acknowledgedBlocks: 2,
    }),
  );
  await expect(job).toContainText("67% 2/3");
  await expect(job).not.toContainText(/\d+\.\d+%/);
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      blocks: 2,
      acknowledgedBlocks: 1,
    }),
  );
  await expect(job).toContainText("50% 1/2");
  await expect(job.locator(":scope > *")).toHaveCount(4);
  await expect(job.locator(".firmware-phase")).toHaveText("传输固件");
  await expect(job.locator(".fui-Badge, details")).toHaveCount(0);
  await expect(job).not.toContainText("已确认 1 / 2 块");
  await expect(
    page.getByRole("button", { name: "停止后续传输", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeEnabled();
  const log = job.getByRole("button", { name: "传输日志", exact: true });
  await log.click();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (call: any) => call.command === "open_firmware_log",
      ),
    ),
  ).toEqual([{ command: "open_firmware_log", args: {} }]);
  for (const width of [393, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator(".firmware-status").evaluate((card) => {
      const style = getComputedStyle(card);
      return {
        width:
          card.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      };
    });
    const progress = (await job.getByRole("progressbar").boundingBox())!;
    expect(Math.abs(progress.width - bounds.width)).toBeLessThan(1);
    const blocks = (await job.getByText("1/2", { exact: true }).boundingBox())!;
    expect(
      Math.abs(blocks.x + blocks.width - progress.x - progress.width),
    ).toBeLessThan(1);
    await page.screenshot({
      path: testInfo.outputPath(`firmware-compact-${width}.png`),
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    (window as any).firmwareLogError = true;
  });
  await log.click();
  await expect(
    page.locator(".fui-Toast").getByText(/无法打开传输日志/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      blocks: 0,
      acknowledgedBlocks: 0,
      logPath: "",
    }),
  );
  await expect(job).toContainText("0% 0/0");
  await expect(log).toBeDisabled();
});

test("real update requires confirmation and locks other device actions while active", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.getByText(
      /已核准 BW150 V1.1.0 原厂文件|文件名型号与当前设备一致|已恢复的升级流程/,
    ),
  ).toHaveCount(0);
  const start = page.getByRole("button", {
    name: "刷写",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("dialog")).toContainText("BW150-test.bin");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "start_firmware",
      ),
    ),
  ).toHaveLength(0);
  await start.click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("50% 1/2");
  await expect(
    page.getByRole("button", { name: "管理设备", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "选择固件文件", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.locator(".fui-Toast")).toContainText("设备保留在 IAP");
  const actions = await page.evaluate(() =>
    (window as any).firmwareCalls.filter((c: any) =>
      ["start_firmware", "cancel_firmware", "send_command"].includes(c.command),
    ),
  );
  expect(actions.map((c: any) => c.command)).toEqual([
    "start_firmware",
    "cancel_firmware",
  ]);
  expect(actions[0].args.path).toBe("test-usb-path");
});

test("IAP recovery works without a normal connection and progress survives page navigation", async ({
  page,
}) => {
  await fixture(page, false, true, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.getByRole("button", { name: "升级 USB 设备", exact: true }),
  ).toHaveAttribute("data-value", "test-usb-path");
  await expect(
    page.getByRole("button", { name: "升级 USB 设备", exact: true }),
  ).toHaveText("ATORCH BW150 V1.0.2 · 924415");
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("传输固件");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await expect(page.getByText(/固件升级正在进行：/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "查看升级进度", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  await page.getByRole("tab", { name: "固件更新", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "固件更新", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "设备设置", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("firmware-job")).toContainText("传输固件");
});

test("confirmed update can close the current recording without a manual pause", async ({
  page,
}) => {
  await fixture(page, false, true, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(page.getByText("确认刷写后将保存并结束当前记录。")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "刷写", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "start_firmware",
      ),
    ),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("传输固件");
});

test("stopped load with paused automatic recording can confirm firmware maintenance", async ({
  page,
}) => {
  await fixture(page, false, true, true);
  await page.evaluate(() => {
    (window as any).firmwareRecordingPaused = true;
  });
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.getByText("确认刷写后将保存并结束当前记录。", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认并开始", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "start_firmware",
      ),
    ),
  ).toHaveLength(0);
});

test("writing cannot be cancelled and FF completion does not claim application verification", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toBeVisible();
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      phase: "writing",
      acknowledgedBlocks: 2,
      cancellable: false,
      message: "数据已传完，等待设备确认烧写完成",
    }),
  );
  await expect(
    page.getByRole("button", { name: "停止", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      phase: "complete",
      active: false,
      flashConfirmed: true,
      message: "正常应用尚未重新出现",
    }),
  );
  await expect(page.getByTestId("firmware-job")).toContainText("升级完成");
  await expect(page.locator(".fui-Toast")).toContainText(
    "正常应用尚未重新出现",
  );
  await expect(
    page
      .getByTestId("firmware-job")
      .getByText("正常应用回读已通过。", { exact: false }),
  ).toHaveCount(0);
});

test("firmware inspection keeps file facts and removes rehearsal and packet controls", async ({
  page,
}, testInfo) => {
  await fixture(page);
  const run = page.getByRole("button", {
    name: "离线预演升级握手",
    exact: true,
  });
  await expect(run).toHaveCount(0);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(page.locator(".firmware-facts")).toContainText("SHA-256");
  await expect(
    page.locator(".firmware-facts dt").filter({ hasText: "CRC16" }),
  ).toHaveText("CRC16");
  await expect(page.getByText(/封装头不包含已核准的型号标识/)).toHaveCount(0);
  await expect(
    page.getByText(/已恢复的升级流程|已核准 BW150 V1.1.0 原厂文件/),
  ).toHaveCount(0);
  await expect(page.getByText("文件名型号", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/仅从文件名提取/)).toHaveCount(0);
  await expect(
    page.getByText("确认刷写后将保存并结束当前记录。", { exact: true }),
  ).toHaveCount(0);
  await expect(run).toHaveCount(0);
  await expect(page.getByText("查看握手与首尾分块")).toHaveCount(0);
  await expect(page.getByTestId("firmware-handshake")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "rehearse_firmware",
      ),
    ),
  ).toEqual([]);
  const commands = await page.evaluate(() =>
    (window as any).firmwareCalls.map((c: any) => c.command),
  );
  expect(commands).toContain("inspect_firmware");
  expect(commands).not.toContain("rehearse_firmware");
  expect(commands).not.toContain("send_command");
  expect(commands).not.toContain("disconnect_device");
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: testInfo.outputPath("firmware-inspection.png"),
    fullPage: true,
  });
});

test("inspection errors or oversized images cannot start flashing", async ({
  page,
}) => {
  await fixture(page, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.locator(".fui-Toast").getByText(/固件编码无效/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "离线预演升级握手", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "刷写", exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("firmware-input").setInputFiles({
    name: "BW150-huge.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(1_024_001),
  });
  await expect(
    page.locator(".fui-Toast").getByText(/固件大小必须/),
  ).toBeVisible();
  const inspect = await page.evaluate(() =>
    (window as any).firmwareCalls.filter(
      (c: any) => c.command === "inspect_firmware",
    ),
  );
  expect(inspect).toHaveLength(1);
});

test("custom binaries and other model versions can be selected for hardware flashing", async ({
  page,
}) => {
  await fixture(page, false, true, false, false, "ATORCH BW600 V2.0.5");
  await page
    .getByTestId("firmware-input")
    .setInputFiles(file("RT1I-experiment.bin"));
  await expect(
    page.getByText(/文件名型号与当前设备不匹配|已核准的 BW150/),
  ).toHaveCount(0);
  await expect(page.locator(".firmware-facts")).toContainText("二进制固件");
  await expect(
    page.getByRole("button", { name: "刷写", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("ATORCH BW600 V2.0.5");
  await expect(page.getByRole("dialog")).toContainText("RT1I-experiment.bin");
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  const calls = await page.evaluate(() =>
    (window as any).firmwareCalls.filter(
      (c: any) => c.command === "start_firmware",
    ),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].args.name).toBe("RT1I-experiment.bin");
});

test("verified completion shows one short floating success and closes after three seconds", async ({
  page,
}, testInfo) => {
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("50% 1/2");
  await page.evaluate(() => {
    Object.assign((window as any).firmwareJob, {
      active: false,
      cancellable: false,
      phase: "complete",
      acknowledgedBlocks: 2,
      finishedAt: Date.now(),
      flashConfirmed: true,
      restoredDevice: { name: "ATORCH BW150 V1.1.0", path: "test-usb-path" },
      message: "设备确认烧写完成，正常应用回读通过，已恢复只读监测",
    });
  });
  const toast = page.locator(".fui-Toast");
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("固件升级完成");
  await expect(page.getByTestId("firmware-job")).toContainText("100% 2/2");
  await expect(
    page.getByText(
      /设备确认烧写完成|设备 FF 完成应答已确认|正常应用回读已通过/,
    ),
  ).toHaveCount(0);
  await expect(page.locator(".fui-Toaster.app-notifications")).toHaveCSS(
    "position",
    "fixed",
  );
  await expect(page.locator("main .fui-Toast, .fui-MessageBar")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("firmware-success.png"),
    fullPage: true,
  });
  await toast.hover();
  await toast.getByRole("button", { name: "关闭", exact: true }).focus();
  await expect(toast).toHaveCount(0, { timeout: 4000 });
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  await page.getByRole("tab", { name: "固件更新", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await expect(page.getByTestId("firmware-job")).toContainText("升级完成");
});

test("firmware failures persist across polling and navigation without duplicate banners", async ({
  page,
}, testInfo) => {
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await page.getByRole("button", { name: "刷写", exact: true }).click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("50% 1/2");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      active: false,
      cancellable: false,
      phase: "failed",
      finishedAt: Date.now(),
      message: "固件传输超时，请重新连接设备后重试",
    }),
  );
  const toast = page.locator(".fui-Toast");
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("固件传输超时");
  await page.clock.install();
  await page.clock.runFor(6000);
  await expect(toast).toHaveCount(1);
  await page.getByRole("button", { name: "设备设置", exact: true }).click();
  await page.getByRole("tab", { name: "固件更新", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("升级未完成");
  await expect(page.getByTestId("firmware-job")).not.toContainText(
    "固件传输超时",
  );
  await expect(page.locator(".fui-MessageBar")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("firmware-failure.png"),
    fullPage: true,
  });
  await toast.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await page.clock.runFor(3000);
  await expect(toast).toHaveCount(0);
});
