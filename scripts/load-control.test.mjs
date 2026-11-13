import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gridBounds,
  loadParameterRange,
  parameterError,
  stepParameter,
  timeLimitError,
  timeLimitWrites,
} from "../apps/app/src/lib/loadControl.ts";

const settings = {
  mode: 0,
  target: 1.234000086,
  cutoffVoltage: 2.549999952,
  overCurrent: 16.123001,
  overPower: 250.100006,
};

test("load bounds use the active mode and round device float32 values to manual precision", () => {
  for (const [mode, min, max, digits, step] of [
    [0, 0, 16.123, 3, 0.1],
    [1, 2.55, 100, 2, 0.1],
    [2, 0.01, 9999.99, 2, 0.1],
    [3, 0, 250.1, 1, 1],
  ]) {
    const range = loadParameterRange("target", { ...settings, mode });
    assert.deepEqual(
      [range.min, range.max, range.digits, range.step],
      [min, max, digits, step],
    );
  }
  assert.equal(loadParameterRange("overCurrent", settings).min, 1.234);
  assert.equal(
    loadParameterRange("overPower", { ...settings, mode: 3 }).min,
    1.2,
  );
  assert.equal(
    loadParameterRange("cutoffVoltage", { ...settings, mode: 1 }).max,
    1.23,
  );
  assert.equal(
    loadParameterRange("target", { ...settings, overCurrent: 100 }).max,
    20,
  );
  assert.equal(
    loadParameterRange("target", { ...settings, mode: 3, overPower: 1000 }).max,
    400,
  );
});

test("manual load values retain finer precision and reject overflow or excess digits", () => {
  for (const [mode, valid, invalid] of [
    [0, "1.237", "1.2371"],
    [1, "6.78", "6.789"],
    [2, ".01", ".001"],
    [3, "10.1", "10.11"],
  ]) {
    const range = loadParameterRange("target", { ...settings, mode });
    assert.equal(parameterError(valid, range), "");
    assert.notEqual(parameterError(invalid, range), "");
    for (const bad of ["", " ", "NaN", "Infinity", "-1", String(range.max + 1)])
      assert.notEqual(parameterError(bad, range), "");
  }
});

test("coarse arrows land on zero-based multiples and never cross a dependent bound", () => {
  const current = loadParameterRange("target", settings);
  assert.equal(stepParameter(NaN, 1, current), 0);
  assert.equal(stepParameter(NaN, -1, current), 0);
  assert.equal(stepParameter(1.234, 1, current), 1.3);
  assert.equal(stepParameter(1.234, -1, current), 1.2);
  assert.equal(stepParameter(1.2, 1, current), 1.3);
  assert.equal(stepParameter(1.2, -1, current), 1.1);
  assert.equal(stepParameter(16.123, 1, current), 16.123);
  assert.equal(stepParameter(16.123, -1, current), 16.1);
  const resistance = loadParameterRange("target", { ...settings, mode: 2 });
  assert.deepEqual(gridBounds(resistance), { min: 0.1, max: 9999.9 });
  assert.equal(stepParameter(0.01, -1, resistance), 0.01);
  assert.equal(stepParameter(0.01, 1, resistance), 0.1);
  assert.equal(stepParameter(9999.99, -1, resistance), 9999.9);
  const narrow = { min: 0.02, max: 0.05, step: 0.1 };
  assert.equal(stepParameter(0.03, 1, narrow), 0.03);
  assert.equal(stepParameter(0.03, -1, narrow), 0.03);
  for (let value = 0.01; value <= 100; value += 0.137) {
    for (const direction of [-1, 1]) {
      const next = stepParameter(value, direction, resistance);
      assert.ok(next >= resistance.min && next <= resistance.max);
      if (next === value) continue;
      assert.ok(Math.abs(next * 10 - Math.round(next * 10)) < 1e-8);
      assert.ok(direction > 0 ? next > value : next <= value);
    }
  }
});

test("duration uses integer hours/minutes within one minute to 99h59m", () => {
  for (const [h, m] of [
    ["0", "1"],
    ["99", "59"],
    ["1", "0"],
  ])
    assert.equal(timeLimitError(h, m), "");
  for (const [h, m] of [
    ["0", "0"],
    ["100", "0"],
    ["0", "60"],
    ["-1", "5"],
    ["1.5", "1"],
    ["1", "1.5"],
    ["", "0"],
  ])
    assert.notEqual(timeLimitError(h, m), "");
});

test("duration write order avoids an intermediate zero and skips unchanged fields", () => {
  assert.deepEqual(timeLimitWrites({ limitHours: 2, limitMinutes: 0 }, 0, 1), [
    { kind: "limitMinutes", value: 1 },
    { kind: "limitHours", value: 0 },
  ]);
  assert.deepEqual(timeLimitWrites({ limitHours: 0, limitMinutes: 1 }, 1, 0), [
    { kind: "limitHours", value: 1 },
    { kind: "limitMinutes", value: 0 },
  ]);
  assert.deepEqual(timeLimitWrites({ limitHours: 1, limitMinutes: 0 }, 1, 30), [
    { kind: "limitMinutes", value: 30 },
  ]);
  assert.deepEqual(
    timeLimitWrites({ limitHours: 99, limitMinutes: 59 }, 99, 59),
    [],
  );
});
