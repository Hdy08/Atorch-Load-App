import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import {
  Button,
  Field,
  Slider,
  SpinButton,
  Spinner,
  type SlotRenderFunction,
} from "@fluentui/react-components";
import {
  gridBounds,
  parameterError,
  stepParameter,
  timeLimitError,
  type LoadParameterRange,
} from "../lib/loadControl";
import { useNotify } from "./Notifications";

function NumberInput({
  label,
  text,
  onChange,
  range,
  disabled,
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
  range: LoadParameterRange;
  disabled: boolean;
}) {
  const value =
    text.trim() && Number.isFinite(Number(text)) ? Number(text) : null;
  const draft = useRef(text);
  draft.current = text;
  const change = (next: string) => {
    draft.current = next;
    onChange(next);
  };
  const stepValue = (direction: 1 | -1) =>
    stepParameter(value ?? range.min, direction, range);
  const bounds = gridBounds(range);
  const renderRoot: SlotRenderFunction<ComponentPropsWithoutRef<"span">> = (
    Root,
    props,
  ) => (
    <Root {...props}>
      {props.children}
      <span className="load-input-unit" aria-hidden="true">
        {range.unit}
      </span>
    </Root>
  );
  return (
    <SpinButton
      root={{ children: renderRoot }}
      aria-label={label}
      inputMode={range.digits ? "decimal" : "numeric"}
      value={value}
      displayValue={text}
      min={range.min}
      max={range.max}
      step={range.step}
      stepPage={range.step}
      precision={range.digits}
      disabled={disabled}
      input={{ onChange: (event) => change(event.target.value) }}
      onKeyDownCapture={(event) => {
        if (disabled || bounds.min > bounds.max) return;
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          change(
            (event.key === "Home" ? bounds.min : bounds.max).toFixed(
              range.digits,
            ),
          );
        }
      }}
      incrementButton={{
        "aria-label": `增加${label}`,
        disabled: disabled || bounds.min > bounds.max || stepValue(1) === value,
      }}
      decrementButton={{
        "aria-label": `减少${label}`,
        disabled:
          disabled || bounds.min > bounds.max || stepValue(-1) === value,
      }}
      onChange={(event, data) => {
        if (data.value === undefined || data.value === null) return;
        const previous = Number(draft.current);
        let next: number;
        if ("key" in event && (event.key === "Home" || event.key === "End"))
          next = event.key === "Home" ? bounds.min : bounds.max;
        else
          next = stepParameter(previous, data.value > previous ? 1 : -1, range);
        if (bounds.min <= bounds.max) change(next.toFixed(range.digits));
      }}
    />
  );
}

export function LoadParameter({
  value,
  range,
  disabled,
  onApply,
}: {
  value: number | undefined;
  range: LoadParameterRange;
  disabled: boolean;
  onApply: (value: number) => Promise<void>;
}) {
  const formatted = value?.toFixed(range.digits) ?? "";
  const notify = useNotify();
  const [text, setText] = useState(formatted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setText(formatted);
    setError("");
  }, [formatted]);
  const bounds = gridBounds(range);
  const sliderValue = Math.min(
    bounds.max,
    Math.max(bounds.min, Number(text) || bounds.min),
  );
  return (
    <div className="parameter load-parameter">
      <Field
        label={range.label}
        validationMessage={error || undefined}
        validationState={error ? "error" : "none"}
      >
        <div className="load-parameter-controls">
          <Slider
            aria-label={`${range.label}滑动条`}
            min={bounds.min}
            max={Math.max(bounds.min, bounds.max)}
            input={{ step: range.step }}
            value={sliderValue}
            disabled={disabled || busy || bounds.min >= bounds.max}
            onKeyDown={(event) => {
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setText(
                  (event.key === "Home" ? bounds.min : bounds.max).toFixed(
                    range.digits,
                  ),
                );
                setError("");
              }
            }}
            onPointerUp={(event) => {
              setText(Number(event.currentTarget.value).toFixed(range.digits));
              setError("");
            }}
            onChange={(_, data) => {
              setText(data.value.toFixed(range.digits));
              setError("");
            }}
          />
          <div className="load-number-unit">
            <NumberInput
              label={range.label}
              text={text}
              onChange={setText}
              range={range}
              disabled={disabled || busy}
            />
          </div>
          <Button
            disabled={disabled || busy || !text.trim()}
            onClick={async () => {
              const invalid = parameterError(text, range);
              setError(invalid);
              if (invalid) return;
              setBusy(true);
              try {
                await onApply(Number(text));
                setText(Number(text).toFixed(range.digits));
              } catch (error) {
                notify({ text: String(error), error: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size="tiny" /> : "应用"}
          </Button>
        </div>
      </Field>
    </div>
  );
}

export function LoadTimeLimit({
  hours,
  minutes,
  disabled,
  onApply,
}: {
  hours: number | undefined;
  minutes: number | undefined;
  disabled: boolean;
  onApply: (hours: number, minutes: number) => Promise<void>;
}) {
  const [h, setHours] = useState(hours?.toString() ?? "");
  const notify = useNotify();
  const [m, setMinutes] = useState(minutes?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setHours(hours?.toString() ?? "");
    setMinutes(minutes?.toString() ?? "");
  }, [hours, minutes]);
  return (
    <div className="parameter load-parameter load-time-limit">
      <Field
        label="运行时限"
        validationMessage={error || undefined}
        validationState={error ? "error" : "none"}
      >
        <div className="load-parameter-controls">
          <Slider
            aria-label="运行时限滑动条"
            min={1}
            max={5999}
            input={{ step: 1 }}
            value={Math.max(1, Math.min(5999, Number(h) * 60 + Number(m) || 1))}
            disabled={disabled || busy}
            onChange={(_, data) => {
              setHours(String(Math.floor(data.value / 60)));
              setMinutes(String(data.value % 60));
              setError("");
            }}
          />
          <div className="load-duration-inputs">
            <div className="load-number-unit">
              <NumberInput
                label="运行时限 / 小时"
                text={h}
                onChange={setHours}
                range={{
                  label: "小时",
                  unit: "时",
                  min: 0,
                  max: 99,
                  step: 1,
                  digits: 0,
                }}
                disabled={disabled || busy}
              />
            </div>
            <div className="load-number-unit">
              <NumberInput
                label="运行时限 / 分钟"
                text={m}
                onChange={setMinutes}
                range={{
                  label: "分钟",
                  unit: "分",
                  min: 0,
                  max: 59,
                  step: 1,
                  digits: 0,
                }}
                disabled={disabled || busy}
              />
            </div>
          </div>
          <Button
            disabled={disabled || busy || !h.trim() || !m.trim()}
            onClick={async () => {
              const invalid = timeLimitError(h, m);
              setError(invalid);
              if (invalid) return;
              setBusy(true);
              try {
                await onApply(Number(h), Number(m));
              } catch (error) {
                notify({ text: String(error), error: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size="tiny" /> : "应用"}
          </Button>
        </div>
      </Field>
    </div>
  );
}
