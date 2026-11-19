import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Overflow,
  OverflowItem,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  useIsOverflowItemVisible,
  useOverflowMenu,
  type Theme,
} from "@fluentui/react-components";
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
} from "@fluentui/react-icons";
import {
  measurementKeys,
  measurements,
  type ChartBounds,
  type MeasurementKey,
} from "../lib/analysis";
import { measurementColor } from "../lib/theme";

type SelectorProps = {
  selected: MeasurementKey[];
  onChange: (selected: MeasurementKey[]) => void;
  bounds?: ChartBounds;
  theme: Theme;
};

function MeasurementCheckbox({
  measurement,
  selected,
  onChange,
  bounds,
  theme,
}: SelectorProps & {
  measurement: MeasurementKey;
}) {
  const key = measurement;
  return (
    <Checkbox
      checked={selected.includes(key)}
      label={
        <span className="series-label">
          <span
            className="series-swatch"
            aria-hidden="true"
            style={{
              backgroundColor:
                bounds?.[key]?.color ?? measurementColor(theme, key),
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
  );
}

function OverflowCheckbox(
  props: SelectorProps & { measurement: MeasurementKey },
) {
  const visible = useIsOverflowItemVisible(props.measurement);
  return visible ? null : <MeasurementCheckbox {...props} />;
}

function MoreMeasurements(props: SelectorProps) {
  const { ref, isOverflowing } = useOverflowMenu<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isOverflowing) setOpen(false);
  }, [isOverflowing]);
  if (!isOverflowing) return null;
  return (
    <Popover
      inline
      open={open}
      onOpenChange={(_, data) => setOpen(data.open)}
      positioning="below-end"
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          ref={ref}
          appearance="subtle"
          aria-label="更多曲线参数"
          aria-expanded={open}
          icon={open ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
          iconPosition="after"
        >
          更多
        </Button>
      </PopoverTrigger>
      <PopoverSurface
        className="chart-parameter-overflow"
        role="group"
        aria-label="更多曲线参数"
      >
        {measurementKeys.map((key) => (
          <OverflowCheckbox key={key} measurement={key} {...props} />
        ))}
      </PopoverSurface>
    </Popover>
  );
}

export function MeasurementSelector(props: SelectorProps) {
  return (
    <Overflow minimumVisible={1}>
      <div className="chart-controls" role="group" aria-label="曲线参数">
        {measurementKeys.map((key) => (
          <OverflowItem id={key} key={key}>
            <div className="measurement-option">
              <MeasurementCheckbox measurement={key} {...props} />
            </div>
          </OverflowItem>
        ))}
        <MoreMeasurements {...props} />
      </div>
    </Overflow>
  );
}
