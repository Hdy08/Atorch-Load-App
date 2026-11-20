import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import { NumericInput } from "./NumericInput";
import {
  Play20Filled,
  Stop20Filled,
  Settings20Regular,
  ReOrderDotsVertical20Regular,
} from "@fluentui/react-icons";
import { modes, type Snapshot } from "../lib/types";
import {
  gridBounds,
  loadParameterRange,
  parameterError,
  stepParameter,
} from "../lib/loadControl";
import { useNotify } from "./Notifications";
import { BleControls } from "./BleControls";
import type { PageLayout } from "../lib/usePageLayout";

const labels = ["恒电流", "恒电压", "恒电阻", "恒功率"];
export interface ControlPosition {
  x: number;
  y: number;
}

export function FloatingLoadControl({
  snapshot,
  busy,
  runDisabled,
  runLabel,
  onSettings,
  onApply,
  onToggle,
  layout,
  position,
  onPositionChange,
  onBleTask,
}: {
  snapshot: Snapshot;
  busy: boolean;
  runDisabled: boolean;
  runLabel: string;
  onSettings: () => void;
  onApply: (value: number) => Promise<void>;
  onToggle: () => void;
  layout: PageLayout | null;
  position: ControlPosition | null;
  onPositionChange: (position: ControlPosition) => void;
  onBleTask: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const notify = useNotify();
  const settings = snapshot.settings;
  const bluetooth = snapshot.device?.transport === "bluetooth";
  const basic =
    !!settings && settings.mode >= 0 && settings.mode <= 3 && !bluetooth;
  const range = basic
    ? loadParameterRange("target", settings, snapshot.loadLimits)
    : undefined;
  const formatted = basic
    ? (settings.target?.toFixed(range!.digits) ?? "")
    : "";
  const [text, setText] = useState(formatted);
  const submitting = useRef(false);
  const control = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 44 });
  const [dragged, setDragged] = useState(position);
  const drag = useRef<{
    id: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const element = control.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const root = element.closest<HTMLElement>(".app");
      const scale =
        Number(getComputedStyle(element).getPropertyValue("--ui-scale")) || 1;
      root?.style.setProperty(
        "--load-control-width",
        `${rect.width / scale}px`,
      );
      root?.style.setProperty(
        "--load-control-height",
        `${rect.height / scale}px`,
      );
      setSize((old) =>
        old.width === rect.width && old.height === rect.height
          ? old
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const clamp = (next: ControlPosition): ControlPosition =>
    layout
      ? {
          x: Math.min(
            Math.max(layout.left, next.x),
            Math.max(layout.left, layout.right - size.width),
          ),
          y: Math.min(
            Math.max(layout.top, next.y),
            Math.max(layout.top, layout.bottom - size.height),
          ),
        }
      : next;
  const location = layout
    ? clamp(
        dragged ?? {
          x: layout.contentRight - size.width,
          y: layout.controlTop,
        },
      )
    : null;
  useEffect(
    () => setText(formatted),
    [formatted, settings?.mode, snapshot.connectedAt],
  );
  const disabled = !snapshot.connected || busy || !basic;
  return (
    <section
      ref={control}
      className={`floating-load-control${bluetooth ? " bluetooth-control" : ""}${dragging ? " dragging" : ""}`}
      aria-label="负载控制"
      style={
        layout && location
          ? {
              ...(dragged
                ? { left: location.x / layout.scale, right: "auto" }
                : {
                    left: "auto",
                    right:
                      (window.innerWidth - layout.contentRight) / layout.scale,
                  }),
              top: location.y / layout.scale,
              maxWidth: layout.contentWidth / layout.scale,
            }
          : undefined
      }
    >
      <Button
        className="control-drag-handle"
        appearance="subtle"
        icon={<ReOrderDotsVertical20Regular />}
        aria-label="拖动负载控制器"
        title="拖动负载控制器"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          const rect = control.current!.getBoundingClientRect();
          drag.current = {
            id: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.id !== event.pointerId) return;
          setDragged(
            clamp({
              x: event.clientX - active.offsetX,
              y: event.clientY - active.offsetY,
            }),
          );
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          const rect = control.current!.getBoundingClientRect();
          onPositionChange(clamp({ x: rect.left, y: rect.top }));
          drag.current = null;
          setDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 40 : 10;
          const movement = {
            ArrowLeft: [-delta, 0],
            ArrowRight: [delta, 0],
            ArrowUp: [0, -delta],
            ArrowDown: [0, delta],
          }[event.key];
          if (!movement || !location) return;
          event.preventDefault();
          const next = clamp({
            x: location.x + movement[0],
            y: location.y + movement[1],
          });
          setDragged(next);
          onPositionChange(next);
        }}
      />
      {bluetooth ? (
        <BleControls
          connected={snapshot.connected}
          busy={busy}
          onTask={onBleTask}
        />
      ) : (
        <>
          <span
            className="mode-code"
            title={
              bluetooth
                ? "蓝牙监测"
                : settings
                  ? modes[settings.mode]?.[1]
                  : "未连接"
            }
          >
            {bluetooth
              ? "BLE"
              : settings
                ? (modes[settings.mode]?.[0] ?? "?")
                : "—"}
          </span>
          {basic && (
            <form
              className="floating-load-target"
              onSubmit={(event) => {
                event.preventDefault();
                if (disabled || submitting.current) return;
                const error = parameterError(text, range!);
                if (error) {
                  notify({ text: error, error: true });
                  return;
                }
                submitting.current = true;
                void onApply(Number(text))
                  .then(() => setText(Number(text).toFixed(range!.digits)))
                  .catch((error) =>
                    notify({ text: String(error), error: true }),
                  )
                  .finally(() => {
                    submitting.current = false;
                  });
              }}
            >
              <span>{labels[settings.mode]}</span>
              <NumericInput
                aria-label={`${range!.label}快速设定`}
                inputMode="decimal"
                focusInputOnStep
                value={text}
                unit={range!.unit}
                min={range!.min}
                max={range!.max}
                step={range!.step}
                precision={range!.digits}
                spinBounds={gridBounds(range!)}
                onStep={(value, direction) =>
                  stepParameter(value, direction, range!)
                }
                disabled={disabled}
                onChange={(_, data) => setText(data.value)}
              />
            </form>
          )}
          <Button
            appearance="subtle"
            icon={<Settings20Regular />}
            aria-label="负载控制设置"
            onClick={onSettings}
          />
          <Button
            appearance="primary"
            icon={
              snapshot.telemetry?.running ? <Stop20Filled /> : <Play20Filled />
            }
            aria-label={runLabel}
            title={runLabel}
            disabled={runDisabled}
            onClick={onToggle}
          />
        </>
      )}
    </section>
  );
}
