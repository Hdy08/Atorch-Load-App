import { expect, test, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  fail = false,
  hardware = false,
  recording = false,
  iap = false,
) {
  await page.addInitScript(
    ({ fail, hardware, recording, iap }) => {
      const calls: any[] = [];
      const device = {
        path: "test-usb-path",
        name: iap ? "ATORCH BW150 V1.0.2" : "ATORCH BW150 V1.1.0",
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
            if (command === "discover_devices") return hardware ? [device] : [];
            if (command === "get_usb_diagnostics") return null;
            if (command === "inspect_firmware") {
              if (fail) throw Error("不是已识别的 AC632N 固件封装，请核对文件");
              return {
                name: args.name,
                bytes: 116,
                sha256: "a".repeat(64),
                crc16: "4B37",
                family: "AC632N",
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
                limitation: hardware
                  ? "已核准 BW150 V1.1.0 原厂文件；Windows / Android 可通过 USB 升级或从 IAP V1.0.2 重新传输，需核对接口及描述符。"
                  : "此文件仅支持离线预演",
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
    { fail, hardware, recording, iap },
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
    name: "升级 BW150 固件…",
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
  await expect(page.getByTestId("firmware-job")).toContainText("50.0%");
  await expect(
    page.getByRole("button", { name: "管理设备", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "选择固件文件", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "停止后续传输", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText(
    "设备保留在 IAP",
  );
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
    page.getByText("已发现 IAP 升级模式", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "恢复 BW150 固件…", exact: true })
    .click();
  await page.getByRole("button", { name: "确认并开始", exact: true }).click();
  await expect(page.getByTestId("firmware-job")).toContainText("传输固件");
  await page.getByRole("button", { name: "实时监控", exact: true }).click();
  await page.getByRole("button", { name: "查看升级进度", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "固件更新", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "设备设置", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("firmware-job")).toContainText("传输固件");
});

test("recording or an unverified file cannot start a hardware update", async ({
  page,
}) => {
  await fixture(page, false, true, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.getByText("请先停止负载并暂停记录，再开始升级。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "升级 BW150 固件…", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "start_firmware",
      ),
    ),
  ).toHaveLength(0);
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
    page.getByText("确认升级后将保存并关闭已暂停的记录。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "升级 BW150 固件…", exact: true })
    .click();
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

test("writing cannot be cancelled and FF without application verification is not shown as success", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await page
    .getByRole("button", { name: "升级 BW150 固件…", exact: true })
    .click();
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
    page.getByRole("button", { name: "停止后续传输", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() =>
    Object.assign((window as any).firmwareJob, {
      phase: "failed",
      active: false,
      flashConfirmed: true,
      message: "正常应用尚未重新出现",
    }),
  );
  await expect(page.getByTestId("firmware-job")).toContainText("升级未完成");
  await expect(page.getByTestId("firmware-job")).toContainText(
    "正常应用尚未重新出现",
  );
  await expect(
    page.getByTestId("firmware-job").getByText("升级完成", { exact: true }),
  ).toHaveCount(0);
});

test("firmware inspection and rehearsal are explicit and never send device commands", async ({
  page,
}) => {
  await fixture(page);
  const run = page.getByRole("button", {
    name: "离线预演升级握手",
    exact: true,
  });
  await expect(run).toBeDisabled();
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(page.locator(".firmware-facts")).toContainText("SHA-256");
  await expect(page.getByText(/封装头不包含已核准的型号标识/)).toBeVisible();
  await expect(
    page.getByText(/已恢复的升级流程|已核准 BW150 V1.1.0 原厂文件/),
  ).toHaveCount(0);
  await expect(page.getByText("文件名型号", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/仅从文件名提取/)).toHaveCount(0);
  await expect(run).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).firmwareCalls.filter(
        (c: any) => c.command === "rehearse_firmware",
      ),
    ),
  ).toEqual([]);
  await page.getByText("查看握手与首尾分块").click();
  await expect(page.getByTestId("firmware-handshake")).toContainText(
    "AA 07 02 00 00",
  );
  await run.click();
  await expect(page.getByTestId("firmware-rehearsal")).toContainText(
    "协议预演完成",
  );
  await expect(page.getByTestId("firmware-rehearsal")).toContainText(
    "未向设备发送升级命令",
  );
  const commands = await page.evaluate(() =>
    (window as any).firmwareCalls.map((c: any) => c.command),
  );
  expect(commands).toContain("inspect_firmware");
  expect(commands).toContain("rehearse_firmware");
  expect(commands).not.toContain("send_command");
  expect(commands).not.toContain("disconnect_device");
  for (const width of [393, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: "artifacts/firmware-handshake-ui.png",
    fullPage: true,
  });
});

test("invalid or oversized images clear prior state and cannot rehearse", async ({
  page,
}) => {
  await fixture(page, true);
  await page.getByTestId("firmware-input").setInputFiles(file());
  await expect(
    page.locator(".fui-Toast").getByText(/不是已识别的 AC632N 固件封装/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "离线预演升级握手", exact: true }),
  ).toBeDisabled();
  await page.getByTestId("firmware-input").setInputFiles({
    name: "BW150-huge.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(58 * 65535 + 1),
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

test("other model filename stays visibly incompatible while offline rehearsal works", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByTestId("firmware-input")
    .setInputFiles(file("BW600-test.bin"));
  await expect(page.getByText(/文件名型号与当前设备不匹配/)).toBeVisible();
  await page
    .getByRole("button", { name: "离线预演升级握手", exact: true })
    .click();
  await expect(page.getByTestId("firmware-rehearsal")).toBeVisible();
});
