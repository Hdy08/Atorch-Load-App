import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartAxisRange,
  formatAxisValue,
  groupChartAxes,
  resolveChartTicks,
  chartGridCount,
  readBounds,
  readSharedChartBounds,
  readChartHeight,
  filterSamples,
  summarize,
} from "../apps/app/src/lib/analysis.ts";
import { parseCsv } from "../apps/app/src/lib/csv.ts";
import {
  formatElapsedTime,
  formatClockTime,
  readChartTimeMode,
} from "../apps/app/src/lib/chartTime.ts";

test("curve time labels keep hundredths, carry across minutes, and do not wrap elapsed days", () => {
  assert.equal(formatElapsedTime(0, true), "00:00:00.00");
  assert.equal(formatElapsedTime(1234, true), "00:00:01.23");
  assert.equal(formatElapsedTime(59_999, true), "00:01:00.00");
  assert.equal(formatElapsedTime(3_723_456, true), "01:02:03.46");
  assert.equal(formatElapsedTime(25 * 3_600_000), "25:00:00");
  const time = new Date(2026, 10, 13, 10, 1, 2, 345).getTime();
  assert.equal(formatClockTime(time, true), "10:01:02.35");
  assert.equal(formatClockTime(time + 57_654, true), "10:02:00.00");
});

function withStorage(entries, check) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key) => entries[key] ?? null },
  });
  try {
    check();
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

test("chart time preference defaults to real time and restores only supported choices", () => {
  const entries = {};
  withStorage(entries, () => {
    assert.equal(readChartTimeMode(), "clock");
    entries["atorch-chart-time-mode"] = "elapsed";
    assert.equal(readChartTimeMode(), "elapsed");
    entries["atorch-chart-time-mode"] = "invalid";
    assert.equal(readChartTimeMode(), "clock");
  });
});

test("shared curve settings migrate legacy channels once and honor an explicit reset", () => {
  const entries = {
    "atorch-live-bounds": JSON.stringify({
      voltage: { max: 20, color: "#123456" },
    }),
    "atorch-review-bounds": JSON.stringify({
      voltage: { max: 50 },
      current: { width: 1.5, areaOpacity: 0.4 },
    }),
  };
  withStorage(entries, () => {
    const shared = readSharedChartBounds();
    assert.equal(shared.voltage.max, 20);
    assert.equal(shared.voltage.color, "#123456");
    assert.equal(shared.current.areaOpacity, 0.4);
    entries["atorch-chart-bounds"] = "{}";
    assert.deepEqual(readSharedChartBounds(), {});
    entries["atorch-chart-bounds"] = "malformed";
    assert.deepEqual(readSharedChartBounds(), {});
  });
});

test("curve fill opacity rejects invalid stored values without discarding valid styles", () => {
  withStorage(
    {
      styles: JSON.stringify({
        voltage: { color: "#123456", areaOpacity: 0.25 },
        current: { areaOpacity: 1 },
        power: { areaOpacity: 0 },
        energy: { areaOpacity: -0.1 },
        capacity: { areaOpacity: 1.1 },
        resistance: { areaOpacity: "0.5" },
      }),
    },
    () => {
      const styles = readBounds("styles");
      assert.equal(styles.voltage.areaOpacity, 0.25);
      assert.equal(styles.voltage.color, "#123456");
      assert.equal(styles.current.areaOpacity, 1);
      assert.equal(styles.power.areaOpacity, 0);
      for (const key of ["energy", "capacity", "resistance"])
        assert.equal(styles[key].areaOpacity, undefined);
    },
  );
});

test("legacy device-temperature curve settings migrate to MOS and keep an explicit MOS preference", () => {
  const entries = {
    "atorch-chart-bounds": JSON.stringify({
      deviceTemperature: {
        min: 0,
        max: 100,
        color: "#123456",
        areaOpacity: 0.4,
      },
    }),
  };
  withStorage(entries, () => {
    const migrated = readSharedChartBounds();
    assert.deepEqual(migrated.mosTemperature, {
      min: 0,
      max: 100,
      color: "#123456",
      areaOpacity: 0.4,
    });
    assert.equal(migrated.deviceTemperature, undefined);
    entries["atorch-chart-bounds"] = JSON.stringify({
      mosTemperature: { max: 80 },
      deviceTemperature: { max: 100 },
    });
    assert.equal(readSharedChartBounds().mosTemperature.max, 80);
  });
});

test("shared chart height prefers the new value, migrates live/review and rejects invalid heights", () => {
  const entries = {
    "atorch-live-chart-height": "600",
    "atorch-review-chart-height": "700",
  };
  withStorage(entries, () => {
    assert.equal(readChartHeight(270), 600);
    entries["atorch-chart-height"] = "520";
    assert.equal(readChartHeight(270), 520);
    entries["atorch-chart-height"] = "not a height";
    entries["atorch-live-chart-height"] = "1001";
    assert.equal(readChartHeight(270), 700);
    entries["atorch-review-chart-height"] = "239";
    assert.equal(readChartHeight(270), 270);
  });
});

test("axis labels pad decimals, include units and normalize negative zero", () => {
  assert.equal(formatAxisValue(12, "V"), "12.0 V");
  assert.equal(formatAxisValue(-0, "A"), "0.0 A");
  assert.equal(formatAxisValue(-0.00001, "A"), "0.0 A");
  assert.equal(formatAxisValue(-2.5, "°C"), "-2.5 °C");
  assert.equal(formatAxisValue(1200, "RPM", 0), "1200 RPM");
  assert.equal(formatAxisValue(0.000012, "A", 6), "0.000012 A");
});

test("all units share axes and preserve first selection order across both sides", () => {
  const axes = groupChartAxes(
    [
      "mosTemperature",
      "voltage",
      "current",
      "cpuTemperature",
      "power",
      "energy",
      "fanSpeed",
      "capacity",
      "resistance",
      "ntcTemperature",
    ],
    [],
  );
  assert.deepEqual(
    axes.map((axis) => axis.unit),
    ["°C", "V", "A", "W", "Wh", "RPM", "mAh", "Ω"],
  );
  assert.deepEqual(
    axes.map((axis) => axis.position),
    ["left", "left", "left", "left", "right", "right", "right", "right"],
  );
  assert.deepEqual(axes[0].keys, [
    "mosTemperature",
    "cpuTemperature",
    "ntcTemperature",
  ]);
  assert.equal(
    groupChartAxes(["cpuTemperature", "cpuTemperature"], []).length,
    1,
  );
  const odd = groupChartAxes(["energy", "capacity", "voltage"], []);
  assert.deepEqual(
    odd.map((axis) => axis.position),
    ["left", "left", "right"],
  );
});

test("shared temperature limits cover automatic channels and combine custom ranges", () => {
  const keys = ["cpuTemperature", "ntcTemperature"];
  const rows = [
    { cpuTemperature: 30, ntcTemperature: -10 },
    { cpuTemperature: 40, ntcTemperature: 100 },
  ];
  const [automatic] = groupChartAxes(keys, rows);
  assert.equal(automatic.min, -10);
  assert.equal(automatic.max, undefined);
  const [mixed] = groupChartAxes(keys, rows, {
    cpuTemperature: { min: 20, max: 50 },
  });
  assert.equal(mixed.min, -10);
  assert.equal(mixed.max, 100);
  const [custom] = groupChartAxes(keys, rows, {
    cpuTemperature: { min: 20, max: 50 },
    ntcTemperature: { min: 10, max: 80 },
  });
  assert.equal(custom.min, 10);
  assert.equal(custom.max, 80);
  const [empty] = groupChartAxes(keys, [
    { cpuTemperature: null, ntcTemperature: null },
  ]);
  assert.equal(empty.min, 0);
  assert.equal(empty.max, 1);
  const [small] = groupChartAxes(["voltage"], [{ voltage: 0.000012 }]);
  const ticks = resolveChartTicks(small, 5);
  assert.equal(ticks.precision, 1);
  assert.ok(ticks.max >= 0.000012);
  assert.equal(
    new Set(
      ticks.labelValues.map((v) => formatAxisValue(v, "V", ticks.precision)),
    ).size,
    6,
  );
});

test("chart height selects exactly five or ten intervals and keeps signed current centered", () => {
  assert.equal(chartGridCount(240), 5);
  assert.equal(chartGridCount(519), 5);
  assert.equal(chartGridCount(520), 10);
  assert.equal(chartGridCount(1000), 10);
  const axes = groupChartAxes(
    ["voltage", "current"],
    [{ voltage: 12.05, current: -3 }],
  );
  for (const count of [5, 10]) {
    const [voltage, current] = axes.map((axis) =>
      resolveChartTicks(axis, count),
    );
    assert.equal(voltage.labelValues.length, count + 1);
    assert.equal(current.labelValues.length, count + 1);
    assert.equal(current.min, -current.max);
    assert.ok(current.min <= -3);
    assert.ok(voltage.min === 0 && voltage.max >= 12.05);
    assert.equal((voltage.max - voltage.min) / voltage.interval, count);
  }
  const [custom] = groupChartAxes(["voltage"], [{ voltage: 12 }], {
    voltage: { min: 10, max: 14 },
  });
  const ticks = resolveChartTicks(custom, 10);
  assert.equal(ticks.min, 10);
  assert.equal(ticks.max, 14);
  assert.equal(ticks.interval, 0.4);
});

test("an upper tick of ten switches to integers and numeric columns remain aligned", () => {
  const [axis] = groupChartAxes(["capacity"], [{ capacity: 6599 }]);
  const ticks = resolveChartTicks(axis, 5);
  assert.ok(ticks.interval >= 10);
  assert.equal(ticks.precision, 0);
  assert.equal(formatAxisValue(2000, "mAh", ticks.precision), "2000 mAh");
  assert.equal(formatAxisValue(8, "V", 1, 5), "  8.0 V");
  assert.equal(formatAxisValue(10, "V", 1, 5), " 10.0 V");
  assert.equal(formatAxisValue(-1, "V", 1, 5), " -1.0 V");
  const [voltage] = groupChartAxes(["voltage"], [{ voltage: 12.05 }]);
  const voltageTicks = resolveChartTicks(voltage, 5);
  assert.ok(voltageTicks.interval < 10);
  assert.equal(voltageTicks.precision, 0);
  assert.ok(voltageTicks.labelValues.every(Number.isInteger));
  const [small] = groupChartAxes(["voltage"], [{ voltage: 2.2 }]);
  assert.equal(resolveChartTicks(small, 5).precision, 1);
});

test("default chart axes include zero and center signed current without clipping", () => {
  const rows = [
    { voltage: 12, current: -3 },
    { voltage: 13, current: 1 },
  ];
  assert.deepEqual(chartAxisRange("voltage", rows), { min: 0, max: undefined });
  const range = chartAxisRange("current", rows);
  assert.equal(range.min, -range.max);
  assert.ok(range.max > 3);
  assert.deepEqual(chartAxisRange("current", [{ current: 0 }]), {
    min: -1,
    max: 1,
  });
  assert.deepEqual(chartAxisRange("current", []), { min: -1, max: 1 });
  assert.deepEqual(
    chartAxisRange("current", [{ current: null }, { current: NaN }]),
    { min: -1, max: 1 },
  );
  assert.deepEqual(
    chartAxisRange("cpuTemperature", [{ cpuTemperature: -20 }]),
    { min: -20, max: 0 },
  );
  assert.deepEqual(chartAxisRange("voltage", rows, { min: 10, max: 20 }), {
    min: 10,
    max: 20,
  });
  assert.deepEqual(chartAxisRange("current", rows, { min: -2 }), {
    min: -2,
    max: undefined,
  });
  assert.deepEqual(chartAxisRange("current", rows, { max: 5 }), {
    min: undefined,
    max: 5,
  });
  assert.equal(chartAxisRange("current", [{ current: 0.005 }]).max, 0.006);
});

test("review statistics keep zero and negative values and skip missing measurements", () => {
  const rows = [
    { timestamp: 0, current: -1, energy: null },
    { timestamp: 1000, current: 0, energy: 0 },
    { timestamp: 2000, current: 4, energy: undefined },
  ];
  assert.deepEqual(summarize(rows, "current"), {
    count: 3,
    min: -1,
    max: 4,
    average: 1,
  });
  assert.deepEqual(summarize(rows, "energy"), {
    count: 1,
    min: 0,
    max: 0,
    average: null,
  });
  assert.equal(
    summarize([{ capacity: 100 }, { capacity: 200 }], "capacity").average,
    null,
  );
  assert.deepEqual(summarize(rows, "resistance"), {
    count: 0,
    min: null,
    max: null,
    average: null,
  });
});

test("time selection uses inclusive boundaries and never falls back to unfiltered export", () => {
  const rows = [0, 1000, 2000, 3000].map((timestamp) => ({
    timestamp,
    voltage: timestamp / 1000,
  }));
  assert.deepEqual(
    filterSamples(rows, 1000, 2000).map((r) => r.voltage),
    [1, 2],
  );
  assert.equal(filterSamples(rows), rows);
  assert.deepEqual(filterSamples(rows, 0, 0), [rows[0]]);
  assert.deepEqual(filterSamples(rows, 2000, 1000), []);
  assert.deepEqual(filterSamples(rows, NaN, 2000), []);
  assert.deepEqual(filterSamples(rows, 0, Infinity), []);
  assert.equal(filterSamples(rows, 1000).length, 3);
});

test("historical CSV is sorted chronologically without losing duplicate timestamps", () => {
  const rows = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A)\n2026-11-12T00:00:02Z,12,1\n2026-11-12T00:00:01Z,11,1\n2026-11-12T00:00:01Z,10,1",
  );
  assert.deepEqual(
    rows.map((r) => r.voltage),
    [11, 10, 12],
  );
});
