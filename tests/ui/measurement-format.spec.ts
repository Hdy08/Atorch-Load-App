import { expect, test } from "@playwright/test";

test("missing values in statistics and sample details align with the right edge of each numeric column", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "atorch-chart-selection",
      JSON.stringify(["voltage", "current", "energy", "cpuTemperature"]),
    ),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "数据记录", exact: true }).click();
  await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
    name: "missing-values.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "DATE,VOLTAGE(V),CURRENT(A),MOS_TEMP(℃)\n2026-11-17T00:00:00Z,1.2000,0.100,\n2026-11-17T00:00:01Z,1.3000,0.100,25.0",
    ),
  });
  await expect(
    page.getByRole("table", { name: "采样明细" }).locator("tbody tr"),
  ).toHaveCount(2);
  for (const name of ["采样统计", "采样明细"]) {
    const table = page.getByRole("table", { name });
    await expect(table.locator(".numeric-placeholder").first()).toHaveText("—");
    const gaps = await table
      .locator(".numeric-placeholder")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const cell = element.closest("td")!;
          return (
            cell.getBoundingClientRect().right -
            parseFloat(getComputedStyle(cell).paddingRight) -
            element.getBoundingClientRect().right
          );
        }),
      );
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(1);
  }
  await page.screenshot({
    path: info.outputPath("right-aligned-missing-values.png"),
    fullPage: true,
  });
});

for (const count of [3, 2503]) {
  test(`original precision survives CSV workers, statistics and sorted decimal-aligned hover (${count} samples)`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("atorch-theme", "dark");
      localStorage.setItem(
        "atorch-chart-selection",
        JSON.stringify([
          "current",
          "voltage",
          "power",
          "mosTemperature",
          "energy",
          "capacity",
          "fanSpeed",
        ]),
      );
    });
    await page.goto("/");
    await page.getByRole("button", { name: "数据记录", exact: true }).click();
    const origin = Date.parse("2026-11-17T00:00:00Z");
    const csv =
      "DATE,VOLTAGE(V),CURRENT(A),POWER(W),MOS_TEMP(℃),FAN_SPEED(RPM)\n" +
      Array.from(
        { length: count },
        (_, i) =>
          `${new Date(origin + i * 1000).toISOString()},${(1.2 + (i % 2) * 0.1).toFixed(4)},0.100,2.10,25.0,1200`,
      ).join("\n");
    await page.locator('input[accept=".csv,text/csv"]').setInputFiles({
      name: "original-precision.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    const statistics = page.getByRole("table", { name: "采样统计" });
    const voltage = statistics.getByRole("row").filter({ hasText: "电压 / V" });
    await expect(voltage.getByRole("cell").nth(2)).toHaveText("1.2000");
    await expect(voltage.getByRole("cell").nth(3)).toHaveText("1.3000");
    await expect(voltage.getByRole("cell").nth(4)).toHaveText(/^1\.\d{3}$/);
    const power = statistics.getByRole("row").filter({ hasText: "功率 / W" });
    await expect(power.getByRole("cell").nth(2)).toHaveText("2.10");
    await expect(power.getByRole("cell").nth(4)).toHaveText("2.100");
    const energy = statistics.getByRole("row").filter({ hasText: "电量 / Wh" });
    await expect(energy.getByRole("cell").nth(2)).toHaveText("0.000");
    await expect(energy.getByRole("cell").nth(3)).toHaveText(/^\d+\.\d{3}$/);
    await expect(energy.getByRole("cell").nth(4)).toHaveText("—");
    const detail = page.getByRole("table", { name: "采样明细" });
    const cells = detail.locator("tbody tr").first().getByRole("cell");
    for (const [column, value] of [
      [1, "1.2000"],
      [2, "0.100"],
      [3, "2.10"],
      [6, "25.0"],
      [7, "1200"],
    ] as const)
      await expect(cells.nth(column)).toHaveText(value);
    await expect(cells.nth(4)).toHaveText(/^\d+\.\d{3}$/);
    for (const table of [statistics, detail])
      await expect(table.locator("tbody .numeric-cell").first()).toHaveCSS(
        "text-align",
        "right",
      );
    for (const table of [statistics, detail]) {
      const headers = table.locator(
        "thead th:not(:first-child) .fui-TableHeaderCell__button",
      );
      for (const header of await headers.all()) {
        await expect(header).toHaveCSS("text-align", "right");
        await expect(header).toHaveCSS("justify-content", "flex-end");
      }
    }
    for (const column of [2, 3, 4]) {
      const aligned = await statistics
        .locator(`tbody tr td:nth-child(${column + 1}) .numeric-fraction`)
        .evaluateAll((elements) =>
          elements.map((el) => el.getBoundingClientRect().x),
        );
      expect(Math.max(...aligned) - Math.min(...aligned)).toBeLessThan(1);
    }
    await page.locator(".trend-chart").scrollIntoViewIfNeeded();
    const point = await page.evaluate(async () => {
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
      (window as any).formatChart = chart;
      return {
        x: box.x + grid.x + grid.width * 0.5,
        y: box.y + grid.y + grid.height * 0.5,
      };
    });
    await page.mouse.move(point.x, point.y);
    const tooltip = page.locator(".curve-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".curve-tooltip-row")).toHaveCount(7);
    for (const [key, value] of [
      ["voltage", /^1\.\d{4}$/],
      ["current", "0.100"],
      ["power", "2.10"],
      ["mosTemperature", "25.0"],
      ["fanSpeed", "1200"],
      ["energy", /^\d+\.\d{3}$/],
      ["capacity", /^\d+\.\d{3}$/],
    ] as const)
      await expect(
        tooltip.locator(`[data-measurement="${key}"] strong`),
      ).toHaveText(value);
    const positions = await tooltip
      .locator(".curve-tooltip-row")
      .evaluateAll((elements) => {
        const chart = (window as any).formatChart;
        const options = chart.getOption();
        return elements.map((element) => {
          const key = element.getAttribute("data-measurement");
          const series = options.series.find(
            (series: any) => series.id === key,
          );
          const value = Number(element.querySelector("strong")!.textContent);
          return chart.convertToPixel({ yAxisIndex: series.yAxisIndex }, value);
        });
      });
    for (let i = 1; i < positions.length; i++)
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1] - 1);
    const decimalPositions = await tooltip
      .locator(".numeric-fraction")
      .evaluateAll((elements) =>
        elements.map((el) => el.getBoundingClientRect().x),
      );
    expect(
      Math.max(...decimalPositions) - Math.min(...decimalPositions),
    ).toBeLessThan(1);
    await page.screenshot({
      path: testInfo.outputPath(`precision-${count}.png`),
      fullPage: true,
    });
  });
}
