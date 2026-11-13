import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exportCsv, parseCsv, csvCells } from "../apps/app/src/lib/csv.ts";

test("vendor bilingual CSV with metadata and signed values", () => {
  const rows = parseCsv(
    "vendor metadata\n(时间)DATE,(电压)VOLTAGE(V),(电流)CURRENT(A),(探头温度)NTC_TEMP(℃),\n2026-05-06_22:03:10,4.015,-0.005,-46.344,",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].voltage, 4.015);
  assert.equal(rows[0].current, -0.005);
  assert.equal(rows[0].ntcTemperature, -46.344);
});
test("round trip preserves all electrical values and timestamp", () => {
  const source = {
    timestamp: 1794478093715,
    voltage: 12.34,
    current: -0.005,
    power: 12,
    energy: 3.6,
    capacity: 1500,
    resistance: 10,
    cpuTemperature: 32,
    ntcTemperature: -4,
    mosTemperature: 29,
    fanSpeed: 2000,
    running: null,
    status: 0,
  };
  assert.deepEqual(parseCsv(exportCsv([source])), [source]);
});
test("parses quoted cells and rejects malformed records", () => {
  assert.deepEqual(csvCells('"a,b","c""d",e'), ["a,b", 'c"d', "e"]);
  assert.throws(() => csvCells('"unfinished'), /引号/);
  assert.throws(
    () => parseCsv("DATE,VOLTAGE(V),CURRENT(A)\ninvalid,1,2"),
    /时间/,
  );
  assert.throws(
    () => parseCsv("DATE,VOLTAGE(V),CURRENT(A)\n2026-01-01,NaN,2"),
    /数据/,
  );
  assert.throws(() => parseCsv("DATE,VOLTAGE(V),CURRENT(A)\n"), /没有/);
});
test("BLE records preserve unavailable columns and use the shared MOS temperature", () => {
  const frame = {
    timestamp: 1794478093715,
    voltage: 0,
    current: 0,
    power: 0,
    energy: null,
    capacity: 6620,
    resistance: null,
    cpuTemperature: null,
    ntcTemperature: null,
    mosTemperature: 26,
    fanSpeed: null,
    running: null,
    status: 0,
  };
  const text = exportCsv([frame]);
  assert(!text.includes("DEVICE_TEMP"));
  const cells = csvCells(text.split("\r\n")[1]);
  for (const index of [4, 5, 7, 8, 10]) assert.equal(cells[index], "");
  assert.equal(cells[9], "26");
  assert.deepEqual(parseCsv(text), [
    { ...frame, energy: 0, energyCalculated: true },
  ]);
});

test("legacy device-temperature CSV columns merge into MOS without replacing an explicit MOS value", () => {
  for (const [mos, legacy, expected] of [
    ["", "26", 26],
    ["30", "26", 30],
    ["0", "26", 0],
  ]) {
    const rows = parseCsv(
      `DATE,VOLTAGE(V),CURRENT(A),MOS_TEMP(℃),DEVICE_TEMP(℃)\n2026-11-13T00:00:00Z,12,1,${mos},${legacy}`,
    );
    assert.equal(rows[0].mosTemperature, expected);
    assert.equal(rows[0].deviceTemperature, undefined);
    assert(!exportCsv(rows).includes("DEVICE_TEMP"));
  }
  assert.equal(
    parseCsv(
      "DATE,VOLTAGE(V),CURRENT(A),DEVICE_TEMP(℃)\n2026-11-13T00:00:00Z,12,1,26",
    )[0].mosTemperature,
    26,
  );
});
test("relative charge CSV uses DateTime as its origin and retains signed channels and millisecond time", () => {
  const csv =
    'SUM,4\nTotalTime,="1.00:00:00.100"\nSampTime(ms),100\nDateTime,2026-10-02 17:25:37\n\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n="00:00:00.000",0,0,0,\n="00:00:00.100",5.233,-0.0024,0.0124,\n="00:00:01.234",5,-1,5,\n="1.00:00:00.100",5,-1,5,';
  const rows = parseCsv(csv);
  const start = new Date(2026, 9, 2, 17, 25, 37).getTime();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.elapsedMs),
    [0, 100, 1234, 86_400_100],
  );
  assert.deepEqual(
    rows.map((r) => r.timestamp),
    [start, start + 100, start + 1234, start + 86_400_100],
  );
  assert.equal(rows[1].current, -0.0024);
  assert.equal(rows[1].power, 0.0124);
  for (const row of rows) {
    assert.equal(row.energyCalculated, true);
    assert.equal(row.capacityCalculated, true);
    assert(row.energy >= 0);
    assert(row.capacity >= 0);
    assert.equal(row.mosTemperature, null);
  }
});

test("relative CSV requires a valid origin and rejects invalid durations", () => {
  const header = "Time(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n";
  assert.throws(() => parseCsv(header + '="00:00:00.000",5,1,5,'), /DateTime/);
  assert.throws(
    () => parseCsv("DateTime,invalid\n" + header + '="00:00:00.000",5,1,5,'),
    /DateTime/,
  );
  for (const time of [
    "invalid",
    "00:61:00.000",
    "00:00:60.000",
    "1.24:00:00.000",
    "-00:00:01.000",
  ])
    assert.throws(
      () =>
        parseCsv(
          "DateTime,2026-10-02 17:25:37\n" + header + `="${time}",5,1,5,`,
        ),
      /时间无效/,
    );
});

test("dense charge CSV preserves every complete row including duplicate times and original precision", () => {
  const points = Array.from({ length: 20_001 }, (_, i) => {
    const ms = Math.floor(i / 2) * 100;
    const hours = Math.floor(ms / 3_600_000)
      .toString()
      .padStart(2, "0");
    const minutes = (Math.floor(ms / 60_000) % 60).toString().padStart(2, "0");
    const seconds = (Math.floor(ms / 1000) % 60).toString().padStart(2, "0");
    return `="${hours}:${minutes}:${seconds}.${(ms % 1000).toString().padStart(3, "0")}",${9 + i / 10000},${-i / 10000},${i / 10000},`;
  });
  const csv =
    "DateTime,2026-10-02 17:25:37\nTime(D.hh:mm:ss.ms),Voltage(V),Current(A),Power(W),\n" +
    points.join("\n");
  const rows = parseCsv(csv);
  assert.equal(rows.length, points.length);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.elapsedMs, Math.floor(i / 2) * 100);
    assert.equal(row.voltage, 9 + i / 10000);
    assert.equal(row.current, i === 0 ? 0 : -i / 10000);
    assert.equal(row.power, i / 10000);
    assert.notEqual(row.energy, null);
    assert.notEqual(row.capacity, null);
  }
  const exported = exportCsv(rows).trim().split(/\r?\n/);
  assert.equal(exported.length, rows.length + 1);
  // Export keeps internal precision, including the smallest integrated values.
  const roundTrip = parseCsv(exportCsv(rows));
  for (const [i, row] of roundTrip.entries()) {
    assert.equal(row.energy, rows[i].energy);
    assert.equal(row.capacity, rows[i].capacity);
  }
});

test("all supplied charge CSV rows match their declared SUM and exact source timing", async (t) => {
  const directory = process.env.ATORCH_CSV_DIRECTORY;
  if (!directory) {
    t.skip("Set ATORCH_CSV_DIRECTORY for read-only user CSV verification");
    return;
  }
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries.filter(
    (e) => e.isFile() && e.name.endsWith(".csv"),
  )) {
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path);
    let text = new TextDecoder().decode(bytes);
    if (text.includes("\uFFFD"))
      text = new TextDecoder("gb18030").decode(bytes);
    const expected = Number(/^SUM,(\d+)/m.exec(text)?.[1]);
    const rows = parseCsv(text);
    assert.equal(rows.length, expected, path);
    const sourceRows = text.trim().split(/\r?\n/).slice(6);
    for (const [i, row] of rows.entries()) {
      const cells = csvCells(sourceRows[i]);
      assert.equal(
        row.voltage,
        Number(cells[1]),
        `${entry.name} row ${i} voltage`,
      );
      assert.equal(
        row.current,
        Number(cells[2]),
        `${entry.name} row ${i} current`,
      );
      assert.equal(row.power, Number(cells[3]), `${entry.name} row ${i} power`);
      const match = /(\d+):(\d+):(\d+)\.(\d+)/.exec(cells[0]);
      const ms =
        ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) *
          1000 +
        Number(match[4]);
      assert.equal(row.elapsedMs, ms, `${entry.name} row ${i} time`);
    }
    t.diagnostic(
      `${entry.name}: ${rows.length} complete samples, ${rows.at(-1).elapsedMs} ms`,
    );
  }
});

test("reads all locally supplied vendor CSV files", async (t) => {
  const directory = new URL(
    "../BW600_PC_Application_V1.0.8/Data/",
    import.meta.url,
  );
  const files = await readdir(directory).catch(() => []);
  if (!files.length) {
    t.skip("Optional vendor reference bundle is absent");
    return;
  }
  let samples = 0;
  for (const name of files.filter((f) => f.endsWith(".csv"))) {
    const bytes = await readFile(new URL(name, directory));
    let text = new TextDecoder().decode(bytes);
    if (text.includes("\uFFFD"))
      text = new TextDecoder("gb18030").decode(bytes);
    const rows = parseCsv(text);
    assert(rows.length > 0, name);
    samples += rows.length;
  }
  t.diagnostic(`Imported ${files.length} vendor CSV files, ${samples} samples`);
});
