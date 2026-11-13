import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, exportCsv } from "../apps/app/src/lib/csv.ts";
import {
  packCsvRows,
  unpackCsvRows,
  csvRowWidth,
} from "../apps/app/src/lib/csvTransfer.ts";
import {
  packedChartData,
  chartDimensions,
  packedChartThreshold,
} from "../apps/app/src/lib/chartData.ts";
import { chartTimeline } from "../apps/app/src/lib/chartInteraction.ts";
import { measurementKeys } from "../apps/app/src/lib/analysis.ts";

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

test("full-resolution chart stores retain every row and break only real-time gaps", () => {
  const source = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh),E_CAPACITY(mAh)\n2026-11-14T00:00:00Z,5,1,5,0,0",
  );
  const rows = Array.from({ length: packedChartThreshold }, (_, i) => ({
    ...source[0],
    timestamp: source[0].timestamp + i * 100 + (i > 100 ? 60_000 : 0),
    elapsedMs: i * 100,
    voltage: i / 10_000,
    power: i === 500 ? 400 : 5,
    energy: i / 123456789,
    segmentId: i > 100 ? 1 : 0,
  }));
  const data = packedChartData(rows);
  assert.strictEqual(packedChartData(rows), data);
  assert.equal(data.clock.length / chartDimensions.length, rows.length + 1);
  assert.equal(data.elapsed.length / chartDimensions.length, rows.length);
  for (const elapsed of [false, true]) {
    const expected = chartTimeline(rows, elapsed, rows[0].timestamp);
    const packed = elapsed ? data.elapsed : data.clock;
    assert.equal(packed.length, expected.length * chartDimensions.length);
    for (let i = 0; i < expected.length; i++) {
      const offset = i * chartDimensions.length;
      assert.equal(packed[offset + (elapsed ? 1 : 0)], expected[i].time);
      for (let key = 0; key < measurementKeys.length; key++)
        assert.equal(
          packed[offset + key + 2],
          expected[i].row?.[measurementKeys[key]] ?? NaN,
        );
    }
  }
  const regular = rows.map((row, i) => ({
    ...row,
    timestamp: rows[0].timestamp + i * 100,
    segmentId: 0,
  }));
  const shared = packedChartData(regular);
  assert.strictEqual(shared.clock, shared.elapsed);
  assert.equal(shared.clock.length / chartDimensions.length, rows.length);
});
