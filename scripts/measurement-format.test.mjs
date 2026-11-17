import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../apps/app/src/lib/csv.ts";
import { completeRecordCounters } from "../apps/app/src/lib/records.ts";
import { summarize } from "../apps/app/src/lib/analysis.ts";
import {
  indexedChartData,
  chartRangeSummary,
} from "../apps/app/src/lib/chartData.ts";
import {
  measurementPrecision,
  sourceFractionDigits,
  formatMeasurement,
  cacheDeviceMeasurementPrecision,
} from "../apps/app/src/lib/measurementFormat.ts";

test("live precision follows USB thousandths and BLE field resolution", () => {
  const rows = [];
  cacheDeviceMeasurementPrecision(rows, "usb");
  assert.equal(measurementPrecision(rows).cpuTemperature, 3);
  assert.equal(measurementPrecision(rows).mosTemperature, 3);
  assert.equal(measurementPrecision(rows).ntcTemperature, 3);
  assert.equal(measurementPrecision(rows).fanSpeed, 3);
  cacheDeviceMeasurementPrecision(rows, "bluetooth");
  assert.equal(measurementPrecision(rows).voltage, 1);
  assert.equal(measurementPrecision(rows).current, 3);
  assert.equal(measurementPrecision(rows).power, 3);
  assert.equal(measurementPrecision(rows).capacity, 0);
  assert.equal(measurementPrecision(rows).mosTemperature, 0);
});

test("CSV channel precision retains trailing zeroes, scientific notation and sorted rows without changing raw values", () => {
  const rows = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),MOS_TEMP(℃),DEVICE_TEMP(℃)\n2026-11-17T00:00:01Z,1.2000,-0.020,2.10,25.0,25.00000\n2026-11-17T00:00:00Z,1.23e-2,0.100,1.20,24.0,24.00000",
  );
  const digits = measurementPrecision(rows);
  assert.equal(digits.voltage, 4);
  assert.equal(digits.current, 3);
  assert.equal(digits.power, 2);
  assert.equal(digits.mosTemperature, 1);
  assert.equal(rows[0].voltage, 0.0123);
  assert.equal(formatMeasurement(rows[1].voltage, digits.voltage), "1.2000");
  assert.equal(formatMeasurement(rows[0].current, digits.current), "0.100");
  assert.equal(formatMeasurement(rows[1].energy, 3), "0.000");
  assert.equal(completeRecordCounters(rows), rows);
  assert.equal(measurementPrecision(completeRecordCounters(rows)).voltage, 4);
});

test("numeric formatting uses fixed decimals and eliminates floating point tails and negative zero", () => {
  assert.equal(formatMeasurement(16.899384700000155, 3), "16.899");
  assert.equal(formatMeasurement(-0.00001, 3), "0.000");
  assert.equal(formatMeasurement(12, 4), "12.0000");
  assert.equal(formatMeasurement(5.1, 20), "5.10000000000000000000");
  assert.equal(formatMeasurement(1.2e-9, 12), "0.000000001200");
  assert.equal(formatMeasurement(null, 3), "—");
  assert.equal(formatMeasurement(NaN, 3), "—");
  for (const [text, digits] of [
    ["1.2000", 4],
    ["-1.2300e-2", 6],
    ["1e-3", 3],
    ["1.20e3", 0],
    ["0", 0],
    [".50", 2],
  ])
    assert.equal(sourceFractionDigits(text), digits);
});

test("mixed original and integrated counters preserve the origin of each extremum through indexed range statistics", () => {
  const source = parseCsv(
    "DATE,VOLTAGE(V),CURRENT(A),POWER(W),E_QUANTITY(Wh)\n2026-11-17T00:00:00Z,1.2,0.1,2.1,0.10000\n2026-11-17T00:00:01Z,1.2,0.1,2.1,\n2026-11-17T00:00:02Z,1.2,0.1,2.1,0.10000",
  );
  assert.equal(measurementPrecision(source).energy, 5);
  const rows = Array.from({ length: 2100 }, (_, i) => ({
    ...source[i % 3],
    timestamp: source[0].timestamp + i * 1000,
  }));
  const full = summarize(rows, "energy");
  assert.equal(full.min, 0.1);
  assert.equal(full.minCalculated, undefined);
  assert.equal(full.maxCalculated, true);
  indexedChartData(rows);
  const selected = chartRangeSummary(
    rows,
    "energy",
    { startValue: rows[0].timestamp, endValue: rows.at(-1).timestamp },
    false,
  );
  assert.deepEqual(selected, full);
});
