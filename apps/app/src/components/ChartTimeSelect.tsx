import { Select } from "@fluentui/react-components";
import type { ChartTimeMode } from "../lib/chartTime";

export function ChartTimeSelect({
  value,
  onChange,
}: {
  value: ChartTimeMode;
  onChange: (value: ChartTimeMode) => void;
}) {
  return (
    <Select
      aria-label="曲线时间坐标"
      value={value}
      onChange={(event) =>
        onChange(event.target.value === "elapsed" ? "elapsed" : "clock")
      }
    >
      <option value="clock">真实时间</option>
      <option value="elapsed">相对时间</option>
    </Select>
  );
}
