import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, exportCsv } from "../apps/app/src/lib/csv.ts";
import {
  packCsvRows,
  unpackCsvRows,
  csvRowWidth,
} from "../apps/app/src/lib/csvTransfer.ts";
import {
  indexedChartData,
  chartViewportData,
  chartRangeSummary,
  nearestChartSample,
  chartIndexBuffers,
  cacheChartData,
} from "../apps/app/src/lib/chartData.ts";
import { samplesInChartRange } from "../apps/app/src/lib/chartInteraction.ts";
import { measurementKeys, summarize } from "../apps/app/src/lib/analysis.ts";

test("transferable CSV rows retain all samples, duplicate times, nulls, zeros and full precision", () => {
  const source = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh),E_CAPACITY(mAh),ELAPSED_MS,SEGMENT_ID\n2026-11-14T00:00:00Z,5.12345678,-0.000012345678,,,,0,0\n2026-11-14T00:00:00Z,5,-1,5,0,0,0,0\n2026-11-14T00:00:01Z,5,-2,10,,,1000,0\n2026-11-14T00:01:01Z,5,-2,10,,,2000,1",
  );
  const packed = packCsvRows(source);
  assert.equal(packed.length, source.length * csvRowWidth);
  const restored = new Array(source.length);
  unpackCsvRows(packed, restored, 0, 2);
  unpackCsvRows(packed, restored, 2, source.length);
  assert.deepEqual(restored, source);
  assert.equal(exportCsv(restored), exportCsv(source));
  assert(source.at(-1).energy > 0 && source.at(-1).energy < 0.01);
});

function fixture(count = 20_003) {
  const base = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh),E_CAPACITY(mAh)\n2026-11-14T00:00:00Z,5,1,5,0,0",
  )[0];
  return Array.from({ length: count }, (_, i) => ({
    ...base,
    timestamp: base.timestamp + i * 100,
    elapsedMs: i * 100,
    voltage: Math.sin(i / 13),
    current: Math.cos(i / 31),
    power: i === 10_001 ? 400 : i === 10_002 ? -200 : 5,
    energy: i / 123456789,
    capacity: i / 1000,
  }));
}

test("pixel extrema bound rendered points, preserve per-pixel peaks and recover full raw detail", () => {
  const rows = fixture();
  const index = indexedChartData(rows);
  assert.strictEqual(indexedChartData(rows), index);
  for (const pixels of [1, 2, 37, 400]) {
    const rendered = chartViewportData(
      rows,
      index.clock,
      measurementKeys,
      undefined,
      pixels,
    );
    for (const key of measurementKeys) {
      assert(
        rendered[key].length <= pixels * 2 + 2,
        `${key} stays in the pixel budget`,
      );
      for (const [time, value, source] of rendered[key]) {
        assert.equal(time, rows[source].timestamp);
        assert.equal(value, rows[source][key]);
      }
      if (!summarize(rows, key).count) continue;
      for (let pixel = 0; pixel < pixels; pixel++) {
        const from =
          rows[0].timestamp +
          ((rows.at(-1).timestamp - rows[0].timestamp) * pixel) / pixels;
        const to =
          rows[0].timestamp +
          ((rows.at(-1).timestamp - rows[0].timestamp) * (pixel + 1)) / pixels;
        const bin = rows.filter(
          (r) =>
            r.timestamp >= from &&
            (pixel === pixels - 1 ? r.timestamp <= to : r.timestamp < to),
        );
        const values = bin.map((r) => r[key]).filter((v) => v != null);
        if (!values.length) continue;
        const inside = rendered[key].filter(
          ([time]) =>
            time >= from && (pixel === pixels - 1 ? time <= to : time < to),
        );
        assert(inside.some((p) => p[1] === Math.min(...values)));
        assert(inside.some((p) => p[1] === Math.max(...values)));
      }
    }
  }
  const narrow = {
    startValue: rows[10_000].timestamp,
    endValue: rows[10_010].timestamp,
  };
  const points = chartViewportData(
    rows,
    index.clock,
    ["power"],
    narrow,
    400,
  ).power;
  assert.deepEqual(
    points
      .filter(([time]) => time >= narrow.startValue && time <= narrow.endValue)
      .map((p) => p[2]),
    Array.from({ length: 11 }, (_, i) => i + 10_000),
  );
  assert.equal(
    nearestChartSample(rows, index.clock, rows[10_001].timestamp).power,
    400,
  );
  assert.equal(rows.length, 20_003);
});

test("indexed range statistics and complete exports include original rows and duplicate timestamps", () => {
  const rows = fixture(2097);
  rows[33].timestamp = rows[32].timestamp;
  rows[33].elapsedMs = rows[32].elapsedMs;
  indexedChartData(rows);
  for (const elapsed of [false, true])
    for (const [a, b] of [
      [0, 2096],
      [0, 0],
      [31, 33],
      [32, 64],
      [65, 1000],
      [2080, 2096],
    ]) {
      const time = (i) => (elapsed ? rows[i].elapsedMs : rows[i].timestamp);
      const range = { startValue: time(a), endValue: time(b) };
      const original = rows.filter((row) => {
        const t = elapsed ? row.elapsedMs : row.timestamp;
        return t >= range.startValue && t <= range.endValue;
      });
      const selected = samplesInChartRange(
        rows,
        range,
        elapsed,
        rows[0].timestamp,
      );
      assert.deepEqual(selected, original);
      assert.strictEqual(
        samplesInChartRange(rows, { ...range }, elapsed, rows[0].timestamp),
        selected,
      );
      for (const key of measurementKeys) {
        const actual = chartRangeSummary(rows, key, range, elapsed),
          expected = summarize(original, key);
        assert.equal(actual.count, expected.count);
        assert.equal(actual.min, expected.min);
        assert.equal(actual.max, expected.max);
        if (expected.average === null) assert.equal(actual.average, null);
        else assert(Math.abs(actual.average - expected.average) < 1e-9);
      }
      assert.equal(exportCsv(selected), exportCsv(original));
    }
});

test("LOD leaves pauses and missing channels empty and transfers reusable indexes", () => {
  const rows = fixture(2100).map((row, i) => ({
    ...row,
    timestamp: row.timestamp + (i >= 1000 ? 60_000 : 0),
    segmentId: i >= 1000 ? 1 : 0,
    current: i >= 500 && i < 550 ? null : row.current,
  }));
  const original = indexedChartData(rows);
  const copy = structuredClone(original);
  const restored = structuredClone(copy, { transfer: chartIndexBuffers(copy) });
  assert.equal(copy.clock.times.byteLength, 0);
  assert.strictEqual(restored.clock.channels, restored.elapsed.channels);
  const unpacked = rows.map((r) => ({ ...r }));
  cacheChartData(unpacked, restored);
  for (const elapsed of [false, true]) {
    const view = elapsed ? restored.elapsed : restored.clock;
    const data = chartViewportData(
      unpacked,
      view,
      ["power", "current"],
      undefined,
      100,
    );
    assert.equal(
      data.power.some((p) => p[1] === null),
      !elapsed,
    );
    assert(data.current.some((p) => p[1] === null));
  }
  assert.equal(
    nearestChartSample(unpacked, restored.clock, rows[999].timestamp + 20_000),
    undefined,
  );
  assert.equal(
    nearestChartSample(unpacked, restored.elapsed, rows[1000].elapsedMs),
    unpacked[1000],
  );
});

test("relative time resets are indexed without discarding or reordering source records", () => {
  const rows = fixture(2100).map((row, i) => ({
    ...row,
    elapsedMs: (i % 700) * 100,
  }));
  const index = indexedChartData(rows);
  assert(index.elapsed.order);
  const range = { startValue: 2000, endValue: 3000 };
  assert.deepEqual(
    chartRangeSummary(rows, "power", range, true),
    summarize(
      rows.filter((r) => r.elapsedMs >= 2000 && r.elapsedMs <= 3000),
      "power",
    ),
  );
  const data = chartViewportData(
    rows,
    index.elapsed,
    ["voltage"],
    range,
    100,
  ).voltage;
  assert(data.every((p, i) => !i || p[0] >= data[i - 1][0]));
  assert(data.every((p) => p[1] === rows[p[2]].voltage));
});
