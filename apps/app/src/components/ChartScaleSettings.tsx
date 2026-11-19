import { NumericInput } from "./NumericInput";
import { useEffect, useRef, useState } from "react";
import { Eyedropper20Regular } from "@fluentui/react-icons";
import {
  Button,
  Card,
  Field,
  Input,
  SwatchPicker,
  ColorSwatch,
  type Theme,
} from "@fluentui/react-components";
import { chartPalette, measurementColor } from "../lib/theme";
import { useNotify } from "./Notifications";
import {
  measurements,
  defaultCurveWidth,
  type ChartBounds,
  type MeasurementKey,
} from "../lib/analysis";

type CurveDraft = {
  min: string;
  max: string;
  color: string;
  width: string;
  lineOpacity: string;
  opacity: string;
};

function makeDraft(
  selected: MeasurementKey[],
  bounds: ChartBounds,
  theme: Theme,
): Partial<Record<MeasurementKey, CurveDraft>> {
  return Object.fromEntries(
    selected.map((key) => [
      key,
      {
        min: bounds[key]?.min?.toString() ?? "",
        max: bounds[key]?.max?.toString() ?? "",
        color: bounds[key]?.color ?? measurementColor(theme, key),
        width: String(bounds[key]?.width ?? defaultCurveWidth),
        lineOpacity: String(
          Number(((bounds[key]?.lineOpacity ?? 1) * 100).toFixed(2)),
        ),
        opacity: String(
          Number(((bounds[key]?.areaOpacity ?? 0) * 100).toFixed(2)),
        ),
      },
    ]),
  );
}

function CurveColorInput({
  name,
  value,
  fallback,
  onChange,
}: {
  name: string;
  value: string;
  fallback: string;
  onChange: (color: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="axis-color-input">
      <Input
        aria-label={`${name}颜色`}
        type="text"
        placeholder="#RRGGBB"
        maxLength={7}
        value={value}
        onChange={(_, data) => onChange(data.value)}
        contentAfter={
          <Button
            type="button"
            appearance="subtle"
            size="small"
            icon={<Eyedropper20Regular />}
            aria-label={`${name}取色器`}
            onClick={() => picker.current?.click()}
          />
        }
      />
      <input
        ref={picker}
        className="axis-native-color"
        type="color"
        aria-label={`${name}取色值`}
        tabIndex={-1}
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function ChartScaleSettings({
  selected,
  bounds,
  theme,
  onChange,
  onClose,
  formId,
  externalActions = false,
}: {
  selected: MeasurementKey[];
  bounds: ChartBounds;
  theme: Theme;
  onChange: (bounds: ChartBounds) => void;
  onClose?: () => void;
  formId?: string;
  externalActions?: boolean;
}) {
  const [draft, setDraft] = useState(() => makeDraft(selected, bounds, theme));
  const previousTheme = useRef(theme);
  useEffect(() => {
    const previous = previousTheme.current;
    previousTheme.current = theme;
    if (previous === theme) return;
    setDraft((old) =>
      Object.fromEntries(
        Object.entries(old).map(([name, value]) => {
          const key = name as MeasurementKey;
          return [
            key,
            value &&
            value.color.toLowerCase() ===
              measurementColor(previous, key).toLowerCase()
              ? { ...value, color: measurementColor(theme, key) }
              : value,
          ];
        }),
      ),
    );
  }, [theme]);
  const notify = useNotify();
  const reportError = (text: string) => notify({ text, error: true });
  const update = (key: MeasurementKey, change: Partial<CurveDraft>) => {
    setDraft((old) => ({ ...old, [key]: { ...old[key]!, ...change } }));
  };
  const save = (next: ChartBounds) => {
    onChange(next);
    setDraft(makeDraft(selected, next, theme));
    onClose?.();
  };

  return (
    <form
      id={formId}
      className="curve-settings"
      aria-label="曲线与坐标设置"
      noValidate
      onReset={(event) => {
        event.preventDefault();
        setDraft(makeDraft(selected, {}, theme));
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const next = { ...bounds };
        for (const key of selected) {
          const value = draft[key]!;
          const min = value.min.trim() ? Number(value.min) : undefined;
          const max = value.max.trim() ? Number(value.max) : undefined;
          const color = value.color;
          const width = Number(value.width);
          const lineOpacity = value.lineOpacity.trim()
            ? Number(value.lineOpacity)
            : NaN;
          const opacity = value.opacity.trim() ? Number(value.opacity) : NaN;
          if (
            (min !== undefined && !Number.isFinite(min)) ||
            (max !== undefined && !Number.isFinite(max)) ||
            (min !== undefined && max !== undefined && min >= max)
          ) {
            reportError(
              `${measurements[key].name}的范围无效；最小值必须小于最大值`,
            );
            return;
          }
          if (
            !/^#[0-9a-f]{6}$/i.test(color) ||
            !Number.isFinite(width) ||
            width < 0.5 ||
            width > 3
          ) {
            reportError(
              `${measurements[key].name}的颜色或线宽无效；线宽范围为 0.5–3.0`,
            );
            return;
          }
          if (
            !Number.isFinite(lineOpacity) ||
            lineOpacity < 0 ||
            lineOpacity > 100
          ) {
            reportError(
              `${measurements[key].name}的曲线不透明度无效；范围为 0–100%`,
            );
            return;
          }
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) {
            reportError(
              `${measurements[key].name}的阴影不透明度无效；范围为 0–100%`,
            );
            return;
          }
          const customColor =
            color.toLowerCase() !== measurementColor(theme, key).toLowerCase();
          if (
            min === undefined &&
            max === undefined &&
            !customColor &&
            width === defaultCurveWidth &&
            lineOpacity === 100 &&
            opacity === 0
          ) {
            delete next[key];
          } else {
            next[key] = {
              min,
              max,
              ...(customColor ? { color } : {}),
              ...(width !== defaultCurveWidth ? { width } : {}),
              ...(lineOpacity !== 100
                ? { lineOpacity: lineOpacity / 100 }
                : {}),
              ...(opacity !== 0 ? { areaOpacity: opacity / 100 } : {}),
            };
          }
        }
        save(next);
      }}
    >
      <div className="axis-settings">
        {selected.map((key) => (
          <Card
            key={key}
            className="axis-card"
            aria-label={`${measurements[key].name}曲线设置`}
          >
            <div className="section-head">
              <h2>{measurements[key].name}</h2>
              <span>{measurements[key].unit}</span>
            </div>
            <div className="axis-inputs">
              {(["min", "max"] as const).map((side) => (
                <Field key={side} label={side === "min" ? "最小值" : "最大值"}>
                  <NumericInput
                    aria-label={`${measurements[key].name}${side === "min" ? "最小值" : "最大值"}`}

                    placeholder="自动"
                    unit={measurements[key].unit}
                    step={0.1}
                    value={draft[key]?.[side] ?? ""}
                    onChange={(_, data) => update(key, { [side]: data.value })}
                  />
                </Field>
              ))}
              <Field label="曲线颜色">
                <CurveColorInput
                  name={measurements[key].name}
                  value={draft[key]?.color ?? measurementColor(theme, key)}
                  fallback={measurementColor(theme, key)}
                  onChange={(color) => update(key, { color })}
                />
              </Field>
              <Field label="线宽（0.5–3.0）">
                <NumericInput
                  aria-label={`${measurements[key].name}线宽`}

                  min={0.5}
                  max={3}
                  step={0.5}
                  value={draft[key]?.width ?? String(defaultCurveWidth)}
                  onChange={(_, data) => update(key, { width: data.value })}
                />
              </Field>
              <div className="axis-swatches">
                <SwatchPicker
                  aria-label={`${measurements[key].name}预设颜色`}
                  selectedValue={
                    draft[key]?.color ?? measurementColor(theme, key)
                  }
                  onSelectionChange={(_, data) =>
                    update(key, { color: data.selectedValue })
                  }
                >
                  {chartPalette(theme).map((color) => (
                    <ColorSwatch
                      key={color}
                      value={color}
                      color={color}
                      aria-label={`${measurements[key].name} ${color}`}
                    />
                  ))}
                </SwatchPicker>
              </div>
              <Field label="曲线不透明度" className="axis-opacity">
                <NumericInput
                  aria-label={`${measurements[key].name}曲线不透明度`}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  value={draft[key]?.lineOpacity ?? "100"}
                  onChange={(_, data) =>
                    update(key, { lineOpacity: data.value })
                  }
                />
              </Field>
              <Field label="阴影不透明度" className="axis-opacity">
                <NumericInput
                  aria-label={`${measurements[key].name}阴影不透明度`}

                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  value={draft[key]?.opacity ?? "0"}
                  onChange={(_, data) => update(key, { opacity: data.value })}
                />
              </Field>
            </div>
          </Card>
        ))}
      </div>
      {!externalActions && (
        <div className="curve-settings-actions">
          {onClose && (
            <Button type="button" onClick={onClose}>
              取消
            </Button>
          )}
          <Button
            type="button"
            onClick={() => {
              const next = { ...bounds };
              selected.forEach((key) => delete next[key]);
              save(next);
            }}
          >
            恢复默认
          </Button>
          <Button type="submit" appearance="primary">
            应用更改
          </Button>
        </div>
      )}
    </form>
  );
}
