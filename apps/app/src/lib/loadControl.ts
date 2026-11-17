import type { DeviceSettings } from "./types";

export type LoadParameterRange = {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  digits: number;
};

const deviceParameterRanges = {
  fullVoltage: {
    label: "充电上限电压",
    unit: "V",
    min: 0,
    max: 100,
    step: 0.1,
    digits: 2,
  },
  cutoffCurrent: {
    label: "充电截止电流",
    unit: "A",
    min: 0,
    max: 20,
    step: 0.1,
    digits: 2,
  },
  ntcLimit: {
    label: "NTC 温度上限",
    unit: "°C",
    min: 0,
    max: 100,
    step: 1,
    digits: 0,
  },
  mosLimit: {
    label: "MOS 温度上限",
    unit: "°C",
    min: 0,
    max: 100,
    step: 1,
    digits: 0,
  },
  brightness: {
    label: "工作亮度",
    unit: "",
    min: 0,
    max: 9,
    step: 1,
    digits: 0,
  },
  standbyBrightness: {
    label: "待机亮度",
    unit: "",
    min: 0,
    max: 9,
    step: 1,
    digits: 0,
  },
  standbySeconds: {
    label: "待机延时",
    unit: "秒",
    min: 10,
    max: 60,
    step: 1,
    digits: 0,
  },
} satisfies Record<string, LoadParameterRange>;

export type LoadParameterKind =
  | "target"
  | "cutoffVoltage"
  | "overCurrent"
  | "overPower"
  | keyof typeof deviceParameterRanges;

const rounded = (value: number, digits: number) =>
  Number(value.toFixed(digits));

export function loadParameterRange(
  kind: LoadParameterKind,
  settings: Pick<
    DeviceSettings,
    "mode" | "target" | "cutoffVoltage" | "overCurrent" | "overPower"
  >,
): LoadParameterRange {
  const target = settings.target ?? 0;
  switch (kind) {
    case "target":
      switch (settings.mode) {
        case 1:
          return {
            label: "目标电压",
            unit: "V",
            min: rounded(settings.cutoffVoltage, 2),
            max: 100,
            step: 0.1,
            digits: 2,
          };
        case 2:
          return {
            label: "目标电阻",
            unit: "Ω",
            min: 0.01,
            max: 9999.99,
            step: 0.1,
            digits: 2,
          };
        case 3:
          return {
            label: "目标功率",
            unit: "W",
            min: 0,
            max: Math.min(400, rounded(settings.overPower, 1)),
            step: 1,
            digits: 1,
          };
        default:
          return {
            label: "目标电流",
            unit: "A",
            min: 0,
            max: Math.min(20, rounded(settings.overCurrent, 3)),
            step: 0.1,
            digits: 3,
          };
      }
    case "cutoffVoltage":
      return {
        label: "截止电压",
        unit: "V",
        min: 0,
        max: settings.mode === 1 ? Math.min(100, rounded(target, 2)) : 100,
        step: 0.1,
        digits: 2,
      };
    case "overCurrent":
      return {
        label: "过流保护",
        unit: "A",
        min: settings.mode === 0 ? rounded(target, 3) : 0,
        max: 20,
        step: 0.1,
        digits: 3,
      };
    case "overPower":
      return {
        label: "过功率保护",
        unit: "W",
        min: settings.mode === 3 ? rounded(target, 1) : 0,
        max: 400,
        step: 1,
        digits: 1,
      };
    default:
      return deviceParameterRanges[kind];
  }
}

export function parameterError(
  text: string,
  range: LoadParameterRange,
): string {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) return "请输入有效数值";
  if (value < range.min || value > range.max)
    return `请输入 ${range.min}–${range.max} ${range.unit} 范围内的数值`;
  if (Math.abs(value - rounded(value, range.digits)) > 1e-8)
    return `输入精度为 ${10 ** -range.digits} ${range.unit}`;
  return "";
}

// Coarse controls use multiples of step measured from zero, even when a typed
// value or a dependent bound lies between two coarse values.
export function gridBounds(
  range: Pick<LoadParameterRange, "min" | "max" | "step">,
) {
  return {
    min: rounded(Math.ceil(range.min / range.step - 1e-8) * range.step, 6),
    max: rounded(Math.floor(range.max / range.step + 1e-8) * range.step, 6),
  };
}

export function stepParameter(
  value: number,
  direction: 1 | -1,
  range: Pick<LoadParameterRange, "min" | "max" | "step">,
): number {
  const bounds = gridBounds(range);
  if (bounds.min > bounds.max) return value;
  if (!Number.isFinite(value)) return bounds.min;
  const next = rounded(
    (direction > 0
      ? Math.floor(value / range.step + 1e-8) + 1
      : Math.ceil(value / range.step - 1e-8) - 1) * range.step,
    6,
  );
  if (
    (direction > 0 && value >= bounds.max) ||
    (direction < 0 && value <= bounds.min)
  )
    return value;
  return Math.min(bounds.max, Math.max(bounds.min, next));
}

export function timeLimitError(hours: string, minutes: string): string {
  if (!hours.trim() || !minutes.trim()) return "请输入小时和分钟";
  const h = Number(hours),
    m = Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m))
    return "小时和分钟只能输入整数";
  if (h < 0 || h > 99 || m < 0 || m > 59 || h * 60 + m < 1)
    return "运行时限范围为 0 小时 1 分钟至 99 小时 59 分钟";
  return "";
}

export function timeLimitWrites(
  current: Pick<DeviceSettings, "limitHours" | "limitMinutes">,
  hours: number,
  minutes: number,
): { kind: "limitHours" | "limitMinutes"; value: number }[] {
  const writes = [
    { kind: "limitHours" as const, value: hours, previous: current.limitHours },
    {
      kind: "limitMinutes" as const,
      value: minutes,
      previous: current.limitMinutes,
    },
  ];
  // The device exposes two separate commands. Keep every intermediate duration
  // positive when crossing between a sub-hour and an hour-or-longer duration.
  if (hours === 0) writes.reverse();
  return writes
    .filter((write) => write.value !== write.previous)
    .map(({ kind, value }) => ({ kind, value }));
}
