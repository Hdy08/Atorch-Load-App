import { test } from "node:test";
import assert from "node:assert/strict";
import { completeRecordCounters } from "../apps/app/src/lib/records.ts";
import { parseCsv } from "../apps/app/src/lib/csv.ts";

const row = (timestamp, power, current, extra = {}) => ({
  timestamp,
  power,
  current,
  energy: null,
  capacity: null,
  ...extra,
});
const close = (actual, expected) =>
  assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("missing counters integrate irregular intervals with signed charging current", () => {
  const source = [row(0, 10, -1), row(1000, 20, -2), row(4000, 40, -4)];
  const result = completeRecordCounters(source);
  close(result[2].energy, 105 / 3600);
  close(result[2].capacity, 10.5 / 3.6);
  assert.equal(result[0].energy, 0);
  assert.equal(result[0].capacity, 0);
  assert(result.every((r) => r.energyCalculated && r.capacityCalculated));
  assert.equal(source[2].energy, null);
  assert.deepEqual(completeRecordCounters(result), result);
});

test("original counters including zero anchor subsequent gaps independently", () => {
  const rows = completeRecordCounters([
    row(0, 36, 3.6, { energy: 10, capacity: 100 }),
    row(1000, 36, 3.6, { energy: 0 }),
    row(2000, 36, 3.6, { capacity: 0 }),
    row(3000, 36, 3.6),
  ]);
  assert.equal(rows[0].energyCalculated, undefined);
  assert.equal(rows[1].energy, 0);
  assert.equal(rows[1].energyCalculated, undefined);
  close(rows[1].capacity, 101);
  close(rows[2].energy, 0.01);
  assert.equal(rows[2].capacity, 0);
  close(rows[3].capacity, 1);
  close(rows[3].energy, 0.02);
});

test("effective sample time excludes pauses and filtering keeps the original cumulative origin", () => {
  const rows = completeRecordCounters([
    row(0, 36, 3.6, { elapsedMs: 0 }),
    row(1000, 36, 3.6, { elapsedMs: 1000 }),
    row(61_000, 36, 3.6, { elapsedMs: 2000 }),
  ]);
  close(rows.at(-1).energy, 0.02);
  close(rows.at(-1).capacity, 2);
  const filtered = rows.filter((r) => r.timestamp >= 61_000);
  assert.equal(completeRecordCounters(filtered)[0].capacity, 2);
});

test("duplicate times and reset elapsed clocks cannot subtract cumulative values", () => {
  const rows = completeRecordCounters([
    row(1000, -36, -3.6, { elapsedMs: 1000 }),
    row(1000, -36, -3.6, { elapsedMs: 1000 }),
    row(2000, -36, -3.6, { elapsedMs: 0 }),
    row(3000, -36, -3.6, { elapsedMs: 1000 }),
  ]);
  assert.equal(rows[2].energy, 0);
  close(rows[3].energy, 0.01);
  close(rows[3].capacity, 1);
});

test("native automatic recording CSV preserves effective time and calculates missing energy", () => {
  const rows = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh),E_CAPACITY(mAh),ELAPSED_MS\n2026-11-13T00:00:00Z,10,-3.6,36,,100,0\n2026-11-13T00:01:01Z,10,-3.6,36,,101,1000",
  );
  close(rows[1].energy, 0.01);
  assert.equal(rows[1].capacity, 101);
  assert.equal(rows[1].capacityCalculated, undefined);
  assert.equal(rows[1].elapsedMs, 1000);
});
