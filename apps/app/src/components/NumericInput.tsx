import { useRef, type ComponentPropsWithoutRef, type MouseEvent } from "react";
import {
  SpinButton,
  type SlotRenderFunction,
  type SpinButtonChangeEvent,
  type SpinButtonProps,
} from "@fluentui/react-components";

type NumericInputProps = Omit<
  SpinButtonProps,
  | "value"
  | "displayValue"
  | "onChange"
  | "root"
  | "input"
  | "incrementButton"
  | "decrementButton"
> & {
  value: string;
  unit?: string;
  onChange: (event: SpinButtonChangeEvent, data: { value: string }) => void;
  /** Coarse controls can have tighter bounds than values entered by hand. */
  spinBounds?: { min: number; max: number };
  onStep?: (value: number, direction: 1 | -1) => number;
  focusInputOnStep?: boolean;
};

const decimalPlaces = (value: number) => {
  const [base, exponent = "0"] = String(value).split("e");
  return Math.max(0, (base.split(".")[1]?.length ?? 0) - Number(exponent));
};

/** An editable Fluent input, followed by its unit and the native spin controls. */
export function NumericInput({
  value: text,
  unit = "",
  onChange,
  className = "",
  min,
  max,
  step = 1,
  precision,
  disabled,
  spinBounds,
  onStep,
  focusInputOnStep = false,
  onKeyDownCapture,
  ...props
}: NumericInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const value =
    text.trim() && Number.isFinite(Number(text)) ? Number(text) : null;
  const draft = useRef(text);
  draft.current = text;
  const digits =
    precision ??
    Math.min(12, Math.max(decimalPlaces(step), decimalPlaces(value ?? 0)));
  const bounds = spinBounds ?? { min: min ?? -Infinity, max: max ?? Infinity };
  const nextStep = (current: number, direction: 1 | -1) =>
    onStep
      ? onStep(current, direction)
      : Math.min(
          bounds.max,
          Math.max(
            bounds.min,
            Number((current + step * direction).toFixed(digits)),
          ),
        );
  const change = (event: SpinButtonChangeEvent, next: string) => {
    draft.current = next;
    onChange(event, { value: next });
  };
  const label = props["aria-label"] ?? "数值";
  const renderRoot: SlotRenderFunction<ComponentPropsWithoutRef<"span">> = (
    Root,
    rootProps,
  ) => (
    <Root {...rootProps}>
      {rootProps.children}
      <span className="numeric-input-unit load-input-unit" aria-hidden="true">
        {unit}
      </span>
    </Root>
  );
  const noSteps = disabled || bounds.min > bounds.max;
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const onSpinMouseDown = focusInputOnStep
    ? (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        focusInput();
      }
    : undefined;
  return (
    <SpinButton
      {...props}
      ref={inputRef}
      className={`numeric-input ${className}`}
      root={{ children: renderRoot }}
      value={value}
      displayValue={text}
      min={min}
      max={max}
      step={step}
      stepPage={step}
      precision={digits}
      inputMode={props.inputMode ?? (digits ? "decimal" : "numeric")}
      disabled={disabled}
      input={{ onChange: (event) => change(event, event.target.value) }}
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (event.defaultPrevented || noSteps) return;
        const bound =
          event.key === "Home"
            ? bounds.min
            : event.key === "End"
              ? bounds.max
              : NaN;
        if (!event.shiftKey && Number.isFinite(bound)) {
          event.preventDefault();
          change(event, bound.toFixed(digits));
        }
      }}
      incrementButton={{
        "aria-label": `增加${label}`,
        disabled: noSteps || (value !== null && nextStep(value, 1) <= value),
        onMouseDown: onSpinMouseDown,
        onClick: focusInputOnStep ? focusInput : undefined,
      }}
      decrementButton={{
        "aria-label": `减少${label}`,
        disabled: noSteps || (value !== null && nextStep(value, -1) >= value),
        onMouseDown: onSpinMouseDown,
        onClick: focusInputOnStep ? focusInput : undefined,
      }}
      onChange={(event, data) => {
        // Text edits are published immediately by the input slot. Do not round
        // or clamp them on blur/Enter: the owning form performs validation.
        if (noSteps || data.value === undefined || data.value === null) return;
        const button =
          event.type === "mousedown" && event.target instanceof Element
            ? event.target.closest("button")
            : null;
        const key = "key" in event ? event.key : undefined;
        const direction =
          button?.classList.contains("fui-SpinButton__incrementButton") ||
          key === "ArrowUp" ||
          key === "PageUp"
            ? 1
            : button?.classList.contains("fui-SpinButton__decrementButton") ||
                key === "ArrowDown" ||
                key === "PageDown"
              ? -1
              : undefined;
        // Fluent can propose a value based on its previous edit buffer. Use the
        // actual spin action with our current draft; blur/Enter are not steps.
        if (!direction) return;
        const previous =
          draft.current.trim() && Number.isFinite(Number(draft.current))
            ? Number(draft.current)
            : null;
        const current = previous ?? min ?? 0;
        const next = nextStep(current, direction);
        if (Number.isFinite(next)) change(event, next.toFixed(digits));
      }}
    />
  );
}
