import { Checkbox, type Theme } from "@fluentui/react-components";
import {
  measurementKeys,
  measurements,
  type ChartBounds,
  type MeasurementKey,
} from "../lib/analysis";
import { measurementColor } from "../lib/theme";

export function MeasurementSelector({
  selected,
  onChange,
  bounds,
  theme,
}: {
  selected: MeasurementKey[];
  onChange: (selected: MeasurementKey[]) => void;
  bounds: ChartBounds;
  theme: Theme;
}) {
  return (
    <div className="chart-controls" role="group" aria-label="曲线参数">
      {measurementKeys.map((key) => (
        <Checkbox
          key={key}
          checked={selected.includes(key)}
          label={
            <span className="series-label">
              <span
                className="series-swatch"
                aria-hidden="true"
                style={{
                  backgroundColor:
                    bounds[key]?.color ?? measurementColor(theme, key),
                }}
              />
              {measurements[key].name}
            </span>
          }
          onChange={(_, data) => {
            if (data.checked)
              onChange([...selected.filter((item) => item !== key), key]);
            else if (selected.length > 1)
              onChange(selected.filter((item) => item !== key));
          }}
        />
      ))}
    </div>
  );
}
