import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartTimeline,
  samplesInChartRange,
  zoomAxisRange,
  pinchAxisRange,
} from "../apps/app/src/lib/chartInteraction.ts";
import { exportCsv, parseCsv } from "../apps/app/src/lib/csv.ts";

const row = (timestamp, elapsedMs, segmentId) => ({
  timestamp,
  elapsedMs,
  segmentId,
  voltage: 12,
  current: 1,
  power: 12,
  energy: 0,
  capacity: 0,
  resistance: null,
  ntcTemperature: null,
  cpuTemperature: null,
  mosTemperature: null,
  fanSpeed: null,
  running: null,
  status: 0,
});

test("real time leaves pauses empty and relative time joins effective samples", () => {
  const rows = [
    row(0, 0, 0),
    row(1000, 1000, 0),
    row(31_500, 1500, 1),
    row(32_500, 2500, 1),
  ];
  const clock = chartTimeline(rows, false, 0);
  assert.equal(clock.length, 5);
  assert.deepEqual(clock[2], { time: 16_250 });
  assert.equal(clock.filter((point) => point.row).length, rows.length);
  assert.deepEqual(
    chartTimeline(rows, true, 0).map((point) => point.time),
    [0, 1000, 1500, 2500],
  );
  assert.equal(rows.length, 4);
});

test("segment changes break even short pauses, while regular jitter and rate changes stay connected", () => {
  const rows = [
    row(0, 0, 0),
    row(105, 100, 0),
    row(210, 200, 1),
    row(300, 300, 1),
  ];
  assert.equal(chartTimeline(rows, false, 0).length, 5);
  const jitter = [row(0), row(1002), row(1998), row(3000)];
  assert.equal(chartTimeline(jitter, false, 0).length, 4);
  const rates = [
    row(0, 0, 0),
    row(100, 100, 0),
    row(200, 200, 0),
    row(1200, 1200, 0),
  ];
  assert.equal(chartTimeline(rates, false, 0).length, 4);
});

test("legacy CSV gaps are detected without generating synthetic zero measurements", () => {
  const rows = [row(0), row(1000), row(2000), row(60_000), row(61_000)];
  const points = chartTimeline(rows, false, 0);
  assert.equal(points.length, 6);
  assert.equal(points[3].row, undefined);
  assert.equal(points[3].time, 31_000);
  assert.equal(chartTimeline([], false, 0).length, 0);
  assert.deepEqual(chartTimeline([row(0)], false, 0), [
    { time: 0, row: rows[0] },
  ]);
});

test("range selection includes endpoints, supports empty gaps and effective coordinates", () => {
  const rows = [row(1000, 0), row(2000, 1000), row(61_000, 2000)];
  assert.equal(samplesInChartRange(rows, undefined, false, 1000), rows);
  assert.deepEqual(
    samplesInChartRange(
      rows,
      { startValue: 2000, endValue: 61_000 },
      false,
      1000,
    ),
    rows.slice(1),
  );
  assert.deepEqual(
    samplesInChartRange(
      rows,
      { startValue: 3000, endValue: 50_000 },
      false,
      1000,
    ),
    [],
  );
  assert.deepEqual(
    samplesInChartRange(rows, { startValue: 1000, endValue: 2000 }, true, 1000),
    rows.slice(1),
  );
});

test("wheel zoom stays anchored, clamps time extents and permits independent signed value axes", () => {
  const range = { startValue: 0, endValue: 100 };
  const zoom = zoomAxisRange(range, 0.25, -120, 1);
  assert(zoom.endValue - zoom.startValue < 100);
  assert(
    Math.abs(zoom.startValue + (zoom.endValue - zoom.startValue) * 0.25 - 25) <
      1e-10,
  );
  assert.deepEqual(zoomAxisRange(range, 0.5, 120, 1, range), range);
  const signed = zoomAxisRange({ startValue: -2, endValue: 2 }, 0.5, -120, 0.5);
  assert(signed.startValue < 0 && signed.endValue > 0);
  const clamped = zoomAxisRange(
    { startValue: 99, endValue: 100 },
    1,
    120,
    1,
    range,
  );
  assert.equal(clamped.endValue, 100);
});

test("CSV exports retain pause boundaries and effective time on selected subsets", () => {
  const rows = [row(1000, 0, 0), row(2000, 1000, 0), row(32_000, 2000, 1)];
  const csv = exportCsv(rows);
  assert(csv.split("\r\n")[0].endsWith(",ELAPSED_MS,SEGMENT_ID"));
  assert.deepEqual(parseCsv(csv), rows);
  assert.deepEqual(parseCsv(exportCsv(rows.slice(1))), rows.slice(1));
  assert.throws(() => parseCsv(csv.replace(/,1$/, ",-1")), /分段/);
});

test("pinch uses damped absolute distance, independent of move count and jitter", () => {
  const domain = { startValue: 0, endValue: 1000 };
  const range = { startValue: 200, endValue: 800 };
  const initial = pinchAxisRange(range, 0.5, 100, 100, domain);
  assert.deepEqual(initial, range);
  const doubled = pinchAxisRange(range, 0.5, 100, 200, domain);
  assert(
    Math.abs(doubled.endValue - doubled.startValue - 600 / Math.sqrt(2)) <
      1e-10,
  );
  assert.equal((doubled.startValue + doubled.endValue) / 2, 500);
  const oneMove = pinchAxisRange(range, 0.5, 100, 150, domain);
  let manyMoves;
  for (let distance = 100; distance <= 150; distance++)
    manyMoves = pinchAxisRange(range, 0.5, 100, distance, domain);
  assert.deepEqual(manyMoves, oneMove);
  const jitter = pinchAxisRange(range, 0.5, 100, 100.1, domain);
  assert(Math.abs(jitter.startValue - range.startValue) < 0.2);
  assert.deepEqual(pinchAxisRange(domain, 0, 100, 10, domain), domain);
});
