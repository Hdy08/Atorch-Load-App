import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const encode = (text: string) =>
      btoa(
        Array.from(new TextEncoder().encode(text), (byte) =>
          String.fromCharCode(byte),
        ).join(""),
      );
    const csv =
      'DateTime,2026-10-02 17:25:37\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n="00:00:00.000",9,-0.1,0.9,\n="00:00:00.100",9.1,-0.2,1.82,\n="00:00:00.200",9.2,-0.3,2.76,';
    const disks = {
      "D:/measurements/充电.csv": csv,
      "D:/other/充电.csv": csv,
      "D:/measurements/invalid.csv": "invalid",
    } as Record<string, string>;
    const state = {
      nextPath: "D:/measurements/充电.csv" as string | null,
      savePath: "D:/export/selected.csv" as string | null,
      disks,
      calls: [] as { command: string; args: any }[],
    };
    const getLibrary = () =>
      JSON.parse(localStorage.getItem("fixture-library") ?? "[]");
    const info = (path: string) => ({
      id: path,
      path,
      name: path.split("/").at(-1),
      bytes: disks[path].length,
      modifiedAt: Date.now(),
    });
    const register = (path: string) => {
      const entry = info(path);
      localStorage.setItem(
        "fixture-library",
        JSON.stringify([
          entry,
          ...getLibrary().filter((old: any) => old.id !== path),
        ]),
      );
      return entry;
    };
    const document = (path: string) => ({
      ...info(path),
      dataBase64: encode(disks[path]),
    });
    const rows = [0, 1, 2].map((i) => ({
      timestamp: Date.UTC(2026, 10, 13) + 100 * i,
      voltage: 12,
      current: 1,
      power: 12,
      energy: null,
      capacity: null,
      resistance: null,
      cpuTemperature: null,
      ntcTemperature: null,
      mosTemperature: null,
      fanSpeed: null,
      running: true,
      status: 0,
    }));
    Object.assign(window, {
      isTauri: true,
      libraryFixture: state,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: any) => {
          state.calls.push({ command, args });
          if (command === "set_window_theme") return;
          if (command === "get_snapshot")
            return {
              connected: true,
              device: { name: "BW150", path: "fixture" },
              telemetry: rows.at(-1),
              settings: null,
              sampleCount: rows.length,
              connectedAt: rows[0].timestamp,
              lastReportAt: Date.now(),
              recording: "automatic-not-in-library.csv",
              logs: [],
              error: null,
            };
          if (command === "get_history") return rows;
          if (command === "list_recordings") return getLibrary();
          if (command === "open_csv")
            return state.nextPath ? document(state.nextPath) : null;
          if (command === "register_recording") return register(args.path);
          if (command === "read_recording") return document(args.id);
          if (command === "save_csv") {
            if (!state.savePath) return null;
            disks[state.savePath] = args.content;
            register(state.savePath);
            return state.savePath;
          }
          if (command === "delete_recordings") {
            localStorage.setItem(
              "fixture-library",
              JSON.stringify(
                getLibrary().filter(
                  (entry: any) => !args.ids.includes(entry.id),
                ),
              ),
            );
            return;
          }
          throw new Error(`Unexpected library command ${command}`);
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await expect(
    page.getByText("3 / 3 个采样点", { exact: false }),
  ).toBeVisible();
}

test("manual imports persist references, deduplicate paths, and delete only selected records", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".recording-entry")).toHaveCount(0);
  const importButton = page.getByRole("button", {
    name: "导入 CSV",
    exact: true,
  });
  await importButton.click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await expect(page.locator(".recording-entry")).toContainText(
    "D:/measurements/充电.csv",
  );
  await expect(
    page.getByText("3 / 3 个采样点", { exact: false }),
  ).toBeVisible();
  await importButton.click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).libraryFixture.nextPath = "D:/other/充电.csv";
  });
  await importButton.click();
  await expect(page.locator(".recording-entry")).toHaveCount(2);
  await page.reload();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".recording-entry")).toHaveCount(2);
  const entry = page
    .locator(".recording-entry")
    .filter({ hasText: "D:/other/充电.csv" });
  await entry.getByRole("button", { name: "打开记录" }).click();
  await expect(
    page.getByText("3 / 3 个采样点", { exact: false }),
  ).toBeVisible();
  const remove = page.getByRole("button", { name: "删除记录", exact: true });
  await expect(remove).toBeDisabled();
  await entry.getByRole("checkbox").check();
  await remove.click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await expect(page.locator(".recording-entry")).toContainText(
    "D:/measurements/充电.csv",
  );
  await expect(
    page.getByText("0 / 0 个采样点", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toBeDisabled();
  const state = await page.evaluate(() => ({
    disks: (window as any).libraryFixture.disks,
    library: JSON.parse(localStorage.getItem("fixture-library")!),
    deletion: (window as any).libraryFixture.calls.findLast(
      (call: any) => call.command === "delete_recordings",
    ),
  }));
  expect(state.disks["D:/other/充电.csv"]).toContain("DateTime");
  expect(state.deletion.args.ids).toEqual(["D:/other/充电.csv"]);
  expect(state.library).toHaveLength(1);
  expect(state.library[0]).not.toHaveProperty("dataBase64");
  expect(state.library[0]).not.toHaveProperty("content");
  await page.reload();
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
});

test("deleting an imported record clears its chart immediately while other records and current samples remain", async ({
  page,
}) => {
  await fixture(page);
  const importButton = page.getByRole("button", {
    name: "导入 CSV",
    exact: true,
  });
  await importButton.click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).libraryFixture.nextPath = "D:/other/充电.csv";
  });
  await importButton.click();
  await expect(page.locator(".recording-entry")).toHaveCount(2);
  const remove = page.getByRole("button", { name: "删除记录", exact: true });
  await page
    .locator(".recording-entry")
    .filter({ hasText: "D:/measurements/充电.csv" })
    .getByRole("checkbox")
    .check();
  await remove.click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await expect(
    page.getByText("3 / 3 个采样点", { exact: false }),
  ).toBeVisible();
  await page.locator(".recording-entry").getByRole("checkbox").check();
  await remove.click();
  await expect(page.locator(".recording-entry")).toHaveCount(0);
  await expect(
    page.getByText("0 / 0 个采样点", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".curve-tooltip")).toBeHidden();
  await expect(
    page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "截图", exact: true }),
  ).toBeDisabled();
  const counts = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((url) => url.includes("/echarts_core.js"))!;
    const { getInstanceByDom } = await import(url);
    return getInstanceByDom(document.querySelector(".trend-chart"))
      .getModel()
      .getSeries()
      .map((s: any) => s.getData().count());
  });
  expect(counts).toEqual([0, 0]);
  expect(
    Object.keys(
      await page.evaluate(() => (window as any).libraryFixture.disks),
    ),
  ).toEqual(
    expect.arrayContaining(["D:/measurements/充电.csv", "D:/other/充电.csv"]),
  );
  await page.getByRole("tab", { name: "当前记录", exact: true }).click();
  await expect(
    page.getByText("3 / 3 个采样点", { exact: false }),
  ).toBeVisible();
});

test("invalid imports remain as floating failures until manually closed", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).libraryFixture.nextPath = null;
  });
  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  await expect(page.locator(".fui-Toast")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).libraryFixture.nextPath = "D:/measurements/invalid.csv";
  });
  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  const toast = page.locator(".fui-Toast");
  await expect(toast).toContainText("未找到");
  await expect(page.locator(".fui-Toaster.app-notifications")).toHaveCSS(
    "position",
    "fixed",
  );
  expect(
    await page.evaluate(() =>
      (window as any).libraryFixture.calls.filter(
        (call: any) => call.command === "register_recording",
      ),
    ),
  ).toHaveLength(0);
  await page.clock.install();
  await page.clock.runFor(5000);
  await expect(toast).toContainText("未找到");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const failure = toast.filter({ hasText: "未找到" });
  const success = toast.filter({ hasText: "已导出：" });
  await expect(success).toBeVisible();
  await expect(failure).toBeVisible();
  await page.clock.runFor(3500);
  await expect(success).toHaveCount(0);
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("未找到");
});

test("manual export adds a reference, cancellation adds none, and success closes automatically", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const toast = page.locator(".fui-Toast");
  await expect(toast).toContainText("已导出：D:/export/selected.csv");
  await expect(page.locator("main .fui-Toast")).toHaveCount(0);
  await toast.hover();
  await toast.getByRole("button", { name: "关闭", exact: true }).focus();
  await expect(toast).toHaveCount(0, { timeout: 4000 });
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
  await expect(page.locator(".recording-entry")).toContainText("selected.csv");
  await page.getByRole("tab", { name: "当前记录", exact: true }).click();
  await page.evaluate(() => {
    (window as any).libraryFixture.savePath = null;
  });
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await page.getByRole("tab", { name: "历史记录", exact: true }).click();
  await expect(page.locator(".recording-entry")).toHaveCount(1);
});
