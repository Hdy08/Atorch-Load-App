import { MenuSelect } from "./MenuSelect";
import type { ChartTimeMode } from "../lib/chartTime";

export function ChartTimeSelect({
  value,
  onChange,
}: {
  value: ChartTimeMode;
  onChange: (value: ChartTimeMode) => void;
}) {
  return (
    <MenuSelect
      aria-label="曲线时间坐标"
      value={value}
      onChange={(value) => onChange(value === "elapsed" ? "elapsed" : "clock")}
      options={[
        { value: "clock", label: "绝对时间" },
        { value: "elapsed", label: "相对时间" },
      ]}
    />
  );
}
