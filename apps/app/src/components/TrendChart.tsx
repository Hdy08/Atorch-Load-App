import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, type Theme } from "@fluentui/react-components";
import {
  ArrowReset20Regular,
  Camera20Regular,
  FullScreenMaximize20Regular,
  FullScreenMinimize20Regular,
} from "@fluentui/react-icons";
import { useChartFullscreen } from "./useChartFullscreen";
import { useChartResizeLayout } from "./useChartResizeLayout";
import { MeasurementSelector } from "./MeasurementSelector";
import { ChartAction, ChartActions } from "./ChartAction";
import { init, use, type ECharts } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Telemetry } from "../lib/types";
import { measurementColor } from "../lib/theme";
import { formatElapsedTime, formatClockTime } from "../lib/chartTime";
import {
  formatMeasurement,
  measurementPrecision,
} from "../lib/measurementFormat";
import {
  indexedChartData,
  chartViewportData,
  nearestChartSample,
  chartRangeSummary,
  nearestChartValue,
} from "../lib/chartData";
import { sampleElapsedMs } from "../lib/chartTime";
import {
  chartTimeline,
  nearestTimelineSample,
  samplesInChartRange,
  zoomAxisRange,
  pinchAxisRange,
  clampChartTimeRange,
  minimumChartTimeSpan,
  type ChartTimeRange,
} from "../lib/chartInteraction";
import {
  formatAxisValue,
  chartGridCount,
  chartHeightLimits,
  readChartHeight,
  groupChartAxes,
  resolveChartTicks,
  zoomChartAxis,
  pinchChartAxis,
  panChartAxis,
  constrainChartAxis,
  measurements,
  defaultCurveWidth,
  type ChartBounds,
  type MeasurementKey,
  type ResolvedChartAxis,
} from "../lib/analysis";
use([
  LineChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

export type SeriesKey = MeasurementKey;
export const seriesInfo = measurements;
export type { ChartTimeRange } from "../lib/chartInteraction";
export function TrendChart({
  samples,
  selected,
  onSelectionChange,
  theme,
  bounds,
  imageBusy,
  onImage,
  footerActions,
  exportAction,
  onRangeChange,
  elapsed,
}: {
  samples: Telemetry[];
  selected: SeriesKey[];
  onSelectionChange: (selected: SeriesKey[]) => void;
  theme: Theme;
  bounds?: ChartBounds;
  imageBusy?: boolean;
  onImage?: (url: string) => void;
  footerActions?: ReactNode | ((rows: Telemetry[]) => ReactNode);
  exportAction?: (
    rows: Telemetry[],
    getCurrentRows: () => Telemetry[],
  ) => ReactNode;
  onRangeChange?: (range: ChartTimeRange | undefined) => void;
  elapsed?: { origin: number; current: number; fromZero: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const markers = useRef<HTMLDivElement>(null);
  const selection = useRef<HTMLDivElement>(null);
  const { viewport, fullscreen, rotate, chartHeight, enter, exit } =
    useChartFullscreen();
  const toolbar = useRef<HTMLDivElement>(null);
  const [fullscreenGridTop, setFullscreenGridTop] = useState(52);
  const gridTop = fullscreen ? fullscreenGridTop : 16;
  const gridBottom = fullscreen ? 30 : 42;
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!fullscreen || !element) return;
    // Keep the space below the toolbar equal to its safe-area-aware top inset.
    const update = () =>
      setFullscreenGridTop(element.offsetTop * 2 + element.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fullscreen, rotate, chartHeight]);
  const chart = useRef<ECharts | null>(null);
  const zoom = useRef<(ChartTimeRange & { followEnd: boolean }) | undefined>(
    undefined,
  );
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const coordinates = useRef<
    (x: number, y: number) => { x: number; y: number } | undefined
  >(() => undefined);
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  const wheelAxis = useRef<{
    unit: string;
    x: number;
    y: number;
    at: number;
  } | null>(null);
  const mouse = useRef<(event: PointerEvent) => void>(() => {});
  const mouseGesture = useRef<
    | {
        kind: "pan" | "brush";
        id: number;
        x: number;
        left: number;
        width: number;
        range: ChartTimeRange;
        domain: ChartTimeRange;
      }
    | {
        kind: "axis";
        id: number;
        y: number;
        cellHeight: number;
        axis: ResolvedChartAxis;
      }
    | null
  >(null);
  const mousePosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragCursor = useRef<string | null | undefined>(undefined);
  const lockCursor = useCallback((cursor?: string) => {
    const root = document.documentElement;
    if (cursor) {
      if (dragCursor.current === undefined)
        dragCursor.current = root.dataset.chartDraggingCursor ?? null;
      root.dataset.chartDraggingCursor = cursor;
    } else if (dragCursor.current !== undefined) {
      if (dragCursor.current === null) delete root.dataset.chartDraggingCursor;
      else root.dataset.chartDraggingCursor = dragCursor.current;
      dragCursor.current = undefined;
    }
  }, []);
  const modifier = useRef<(event: KeyboardEvent) => void>(() => {});
  const touch = useRef<(event: TouchEvent) => void>(() => {});
  const touchPointers = useRef(new Set<number>());
  const singleTouch = useRef<{
    id: number;
    point: { x: number; y: number };
    clientX: number;
    clientY: number;
    lastY: number;
    inPlot: boolean;
    mode: "pending" | "drag" | "scroll";
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const activateTouch = useRef<(id: number) => void>(() => {});
  const clearSingleTouch = useCallback(() => {
    if (singleTouch.current) clearTimeout(singleTouch.current.timer);
    singleTouch.current = null;
  }, []);
  const pinch = useRef<
    | ({ distance: number; anchor: number; ids: number[] } & (
        | { kind: "time"; range: ChartTimeRange; domain: ChartTimeRange }
        | { kind: "axis"; axis: ResolvedChartAxis; panned?: boolean }
      ))
    | null
  >(null);
  const clearTouchPointers = useCallback(() => {
    clearSingleTouch();
    for (const id of touchPointers.current)
      if (ref.current?.hasPointerCapture(id))
        ref.current.releasePointerCapture(id);
    touchPointers.current.clear();
    pinch.current = null;
  }, [clearSingleTouch]);
  const interacting = useRef(false);
  const [interactionRevision, setInteractionRevision] = useState(0);
  const queuedUpdate = useRef(false);
  const queuedResize = useRef(false);
  const viewportUpdate = useRef(() => {});
  const viewportFrame = useRef(0);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pendingRange = useRef<ChartTimeRange | undefined>(undefined);
  const lazy = useRef(false);
  const [yRanges, setYRanges] = useState<
    Record<string, ChartTimeRange & { panned?: boolean }>
  >({});
  const manualGridCount = useRef<5 | 10 | undefined>(undefined);
  const [selectedRange, setSelectedRange] = useState<ChartTimeRange>();
  const elapsedMode = elapsed !== undefined;
  const origin = elapsed?.origin ?? 0;
  const index = useMemo(() => indexedChartData(samples), [samples]);
  lazy.current = !!index;
  const coordinate = elapsedMode ? index?.elapsed : index?.clock;
  const timeline = useMemo(
    () => (index ? [] : chartTimeline(samples, elapsedMode, origin)),
    [samples, index, elapsedMode, origin],
  );
  const hoverTimeline = useMemo(
    () => [...timeline].sort((a, b) => a.time - b.time),
    [timeline],
  );
  const seriesData = useMemo(
    () =>
      index
        ? undefined
        : Object.fromEntries(
            selected.map((key) => [
              key,
              timeline.map(({ time, row }) => [time, row?.[key] ?? null]),
            ]),
          ),
    [index, selected, timeline],
  );
  const domain = useMemo(() => {
    if (coordinate)
      return {
        startValue: coordinate.times[0],
        endValue: coordinate.times.at(-1)!,
      };
    let startValue = Infinity,
      endValue = -Infinity;
    for (const row of samples) {
      const value = elapsedMode
        ? (row.elapsedMs ?? row.timestamp - origin)
        : row.timestamp;
      startValue = Math.min(startValue, value);
      endValue = Math.max(endValue, value);
    }
    return { startValue, endValue };
  }, [samples, coordinate, elapsedMode, origin]);
  const hasSamples = samples.length > 0;
  const hasCurve = useMemo(
    () =>
      selected.some(
        (key) =>
          chartRangeSummary(samples, key, undefined, elapsedMode).count > 0,
      ),
    [samples, selected, elapsedMode],
  );
  const interactionAllowed = useRef(false);
  interactionAllowed.current = hasCurve;
  const precision = useMemo(() => measurementPrecision(samples), [samples]);
  const canShowPointer = useRef(false);
  canShowPointer.current = hasCurve;
  const hoverSample = useRef<(time: number) => Telemetry | undefined>(
    () => undefined,
  );
  hoverSample.current = (time) => {
    const row = coordinate
      ? nearestChartSample(samples, coordinate, time)
      : nearestTimelineSample(hoverTimeline, time);
    return row &&
      selected.some((key) => row[key] != null && Number.isFinite(row[key]))
      ? row
      : undefined;
  };
  const hidePointer = useCallback(() => {
    markers.current?.replaceChildren();
    chart.current?.dispatchAction({
      type: "updateAxisPointer",
      currTrigger: "leave",
    });
    chart.current?.dispatchAction({ type: "hideTip" });
  }, []);
  const showPointer = useCallback(() => {
    if (
      mouseGesture.current?.kind === "brush" ||
      mouseGesture.current?.kind === "axis"
    ) {
      hidePointer();
      return;
    }
    const instance = chart.current;
    const position = pointer.current;
    if (
      instance &&
      canShowPointer.current &&
      position &&
      instance.containPixel({ gridIndex: 0 }, [position.x, position.y]) &&
      hoverSample.current(
        Number(instance.convertFromPixel({ xAxisIndex: 0 }, position.x)),
      )
    )
      instance.dispatchAction({ type: "showTip", ...position });
    else hidePointer();
  }, [hidePointer]);
  const syncSelectedRange = useCallback(() => {
    // getOption() deep-copies every raw point. Read only the zoom component.
    const model = (
      chart.current as unknown as {
        getModel(): {
          getComponent(name: string): {
            getPercentRange(): number[];
            getValueRange(axis: "x", index: number): number[];
          };
        };
      } | null
    )
      ?.getModel()
      .getComponent("dataZoom");
    const percent = model?.getPercentRange();
    const values = model?.getValueRange("x", 0);
    const range =
      percent && values
        ? {
            start: percent[0],
            end: percent[1],
            startValue: values[0],
            endValue: values[1],
          }
        : undefined;
    const next =
      range &&
      (range.start > 0 || range.end < 100) &&
      Number.isFinite(range.startValue) &&
      Number.isFinite(range.endValue)
        ? { startValue: range.startValue, endValue: range.endValue }
        : undefined;
    const changed =
      zoom.current?.startValue !== next?.startValue ||
      zoom.current?.endValue !== next?.endValue;
    zoom.current = next
      ? { ...next, followEnd: range!.end >= 100 - 1e-6 }
      : undefined;
    pendingRange.current = next;
    const publish = () =>
      setSelectedRange((previous) =>
        previous?.startValue === next?.startValue &&
        previous?.endValue === next?.endValue
          ? previous
          : next,
      );
    if (lazy.current && changed) {
      cancelAnimationFrame(viewportFrame.current);
      viewportFrame.current = requestAnimationFrame(() =>
        viewportUpdate.current(),
      );
      clearTimeout(publishTimer.current);
      if (!interacting.current) publishTimer.current = setTimeout(publish, 120);
    } else if (!lazy.current) publish();
  }, []);
  const visibleSamples = useMemo(
    () => samplesInChartRange(samples, selectedRange, elapsedMode, origin),
    [samples, selectedRange, elapsedMode, origin],
  );
  useEffect(
    () => onRangeChange?.(selectedRange),
    [selectedRange, onRangeChange],
  );
  const [height, setHeight] = useState(() =>
    readChartHeight(
      window.innerWidth >= 1650 ? 330 : window.innerWidth <= 720 ? 250 : 270,
    ),
  );
  const drag = useRef<{
    id: number;
    y: number;
    height: number;
    scale: number;
  } | null>(null);
  const heightFrame = useRef(0);
  const pendingHeight = useRef<number | undefined>(undefined);
  const resizeLayout = useChartResizeLayout();
  const [resizing, setResizing] = useState(false);
  const setChartHeight = (value: number) =>
    setHeight(
      Math.max(
        chartHeightLimits.min,
        Math.min(chartHeightLimits.max, Math.round(value)),
      ),
    );
  useEffect(() => {
    if (!resizing) localStorage.setItem("atorch-chart-height", String(height));
  }, [height, resizing]);
  useEffect(() => () => cancelAnimationFrame(heightFrame.current), []);
  const flushChartHeight = () => {
    cancelAnimationFrame(heightFrame.current);
    heightFrame.current = 0;
    if (pendingHeight.current !== undefined) {
      setChartHeight(pendingHeight.current);
      pendingHeight.current = undefined;
    }
  };
  const finishResize = () => {
    drag.current = null;
    flushChartHeight();
    setResizing(false);
    resizeLayout.end();
  };
  useLayoutEffect(() => {
    const instance = chart.current;
    if (
      !instance ||
      fullscreen ||
      Math.abs(instance.getHeight() - height) < 0.5
    )
      return;
    // Resize the canvas in the same layout pass as its container. Waiting for
    // ResizeObserver leaves the old bitmap stretched for a frame on each move.
    instance.resize();
    viewportUpdate.current();
    showPointer();
  }, [height, fullscreen, showPointer]);
  const gridCount = Object.keys(yRanges).length
    ? (manualGridCount.current ??
      chartGridCount(fullscreen ? chartHeight : height))
    : chartGridCount(fullscreen ? chartHeight : height);
  const axes = useMemo(() => {
    const grouped = groupChartAxes(selected, samples, bounds, (key) =>
      chartRangeSummary(samples, key, selectedRange, elapsedMode),
    );
    const resolve = (count: 5 | 10) =>
      grouped.map((axis) =>
        resolveChartTicks(
          yRanges[axis.unit]
            ? {
                ...axis,
                min: yRanges[axis.unit].startValue,
                max: yRanges[axis.unit].endValue,
                customMin: true,
                customMax: true,
              }
            : axis,
          count,
          axis.magnitude,
          yRanges[axis.unit]?.panned,
        ),
      );
    const result = resolve(gridCount);
    return result.some((axis) => axis.gridCount !== gridCount)
      ? resolve(10)
      : result;
  }, [
    selected,
    samples,
    bounds,
    gridCount,
    yRanges,
    selectedRange,
    elapsedMode,
  ]);
  const constrainValueRange = (
    axis: ResolvedChartAxis,
    range: ChartTimeRange,
    panning = false,
  ) => {
    const value = nearestChartValue(
      samples,
      axis.keys,
      (range.startValue + range.endValue) / 2,
      zoom.current,
      elapsedMode,
    );
    return value === undefined
      ? undefined
      : constrainChartAxis(axis, range, value, panning);
  };
  const axisHasCurve = (axis: ResolvedChartAxis) =>
    axis.keys.some(
      (key) =>
        chartRangeSummary(samples, key, zoom.current, elapsedMode).count > 0,
    );
  useEffect(
    () =>
      setYRanges((previous) => (Object.keys(previous).length ? {} : previous)),
    [bounds],
  );
  const layout = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${theme.fontSizeBase200} ${theme.fontFamilyMonospace}`;
    const widths = axes.map(
      (axis) =>
        Math.ceil(
          Math.max(
            ...axis.labelValues.map(
              (value) =>
                context.measureText(
                  formatAxisValue(
                    value,
                    axis.unit,
                    axis.precision,
                    axis.numberWidth,
                  ),
                ).width,
            ),
          ),
        ) + 24,
    );
    const leftCount = Math.ceil(axes.length / 2);
    const left = Math.max(
      16,
      widths.slice(0, leftCount).reduce((sum, width) => sum + width, 0),
    );
    const right = Math.max(
      16,
      widths.slice(leftCount).reduce((sum, width) => sum + width, 0),
    );
    return {
      left,
      right,
      minWidth: left + right + (axes.length <= 2 ? 160 : 280),
      widths,
      offsets: widths.map((_, index) =>
        index < leftCount
          ? widths
              .slice(index + 1, leftCount)
              .reduce((sum, width) => sum + width, 0)
          : widths
              .slice(leftCount, index)
              .reduce((sum, width) => sum + width, 0),
      ),
    };
  }, [axes, theme]);
  const viewportData = () =>
    coordinate
      ? chartViewportData(
          samples,
          coordinate,
          selected,
          zoom.current,
          Math.max(
            1,
            (chart.current?.getWidth() ?? ref.current?.clientWidth ?? 1000) -
              layout.left -
              layout.right,
          ),
        )
      : undefined;
  viewportUpdate.current = () => {
    if (!coordinate || !chart.current) return;
    const data = viewportData()!;
    // Merge only series data. Keeping the zoom/grid models alive preserves the
    // current pointer gesture while the newly visible detail arrives.
    chart.current.setOption(
      { series: selected.map((key) => ({ id: key, data: data[key] ?? [] })) },
      { silent: true },
    );
    showPointer();
  };
  const rawTooltip = (input: unknown) => {
    const first = (Array.isArray(input) ? input[0] : input) as
      { axisValue?: number; value?: number[]; dataIndex?: number } | undefined;
    const position = pointer.current;
    let row: Telemetry | undefined;
    if (
      position &&
      chart.current?.containPixel({ gridIndex: 0 }, [position.x, position.y])
    )
      row = hoverSample.current(
        Number(chart.current.convertFromPixel({ xAxisIndex: 0 }, position.x)),
      );
    else if (coordinate && first?.value && first.value[2] >= 0)
      row = samples[first.value[2]];
    else if (coordinate && first?.axisValue !== undefined)
      row = nearestChartSample(samples, coordinate, Number(first.axisValue));
    else if (!coordinate && first?.dataIndex !== undefined)
      row = timeline[first.dataIndex]?.row;
    if (!row) {
      markers.current?.replaceChildren();
      return "";
    }
    const time = elapsedMode
      ? formatElapsedTime(sampleElapsedMs(row, origin), true)
      : formatClockTime(row.timestamp, true);
    const escape = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c]!,
      );
    const entries = selected
      .filter((key) => row[key] != null && Number.isFinite(row[key]))
      .map((key) => {
        const axisIndex = axes.findIndex((axis) => axis.keys.includes(key));
        const y = Number(
          chart.current?.convertToPixel({ yAxisIndex: axisIndex }, row[key]!),
        );
        const digits =
          (key === "energy" && row.energyCalculated) ||
          (key === "capacity" && row.capacityCalculated)
            ? 3
            : precision[key];
        const [integer, fraction] = formatMeasurement(row[key], digits).split(
          ".",
        );
        return {
          key,
          y: Number.isFinite(y) ? y : Infinity,
          integer,
          fraction: fraction ? `.${fraction}` : "",
        };
      })
      .sort((a, b) => a.y - b.y);
    const integerWidth = Math.max(
      1,
      ...entries.map((entry) => entry.integer.length),
    );
    const fractionWidth = Math.max(
      0,
      ...entries.map((entry) => entry.fraction.length),
    );
    // Hover uses the original row, including points omitted by pixel sampling.
    // Render only the selected channels, independently of ECharts' sampled symbols.
    if (markers.current && chart.current) {
      const time = elapsedMode ? sampleElapsedMs(row, origin) : row.timestamp;
      const x = Number(chart.current.convertToPixel({ xAxisIndex: 0 }, time));
      const dots = entries.flatMap(({ key, y }) => {
        if (!chart.current!.containPixel({ gridIndex: 0 }, [x, y])) return [];
        const dot = document.createElement("span");
        dot.className = "chart-hover-marker";
        dot.dataset.measurement = key;
        dot.style.left = `${x}px`;
        dot.style.top = `${y}px`;
        dot.style.backgroundColor =
          bounds?.[key]?.color ?? measurementColor(theme, key);
        return [dot];
      });
      markers.current.replaceChildren(...dots);
    }
    return (
      `<div>${time}</div>` +
      entries
        .map(
          ({ key, integer, fraction }) =>
            `<div class="curve-tooltip-row" data-measurement="${key}"><span><i style="background:${escape(bounds?.[key]?.color ?? measurementColor(theme, key))}"></i>${seriesInfo[key].name} (${seriesInfo[key].unit})</span><strong style="grid-template-columns:${integerWidth}ch ${fractionWidth}ch"><span class="numeric-integer">${integer}</span><span class="numeric-fraction">${fraction}</span></strong></div>`,
        )
        .join("")
    );
  };
  const chartPoint = (clientX: number, clientY: number) => {
    const instance = chart.current;
    if (!instance || !ref.current) return undefined;
    const rect = ref.current.getBoundingClientRect();
    return {
      x: rotate
        ? ((clientY - rect.top) * instance.getWidth()) / rect.height
        : ((clientX - rect.left) * instance.getWidth()) / rect.width,
      y: rotate
        ? ((rect.right - clientX) * instance.getHeight()) / rect.width
        : ((clientY - rect.top) * instance.getHeight()) / rect.height,
    };
  };
  // Native canvas offsets retain subpixel rounding at ordinary UI zoom levels.
  // Only the rotated fullscreen fallback needs physical-coordinate remapping.
  coordinates.current = rotate ? chartPoint : () => undefined;
  const timeDomain = () => {
    const result = { ...domain };
    if (elapsedMode) {
      if (elapsed?.fromZero) result.startValue = 0;
    }
    if (hasSamples)
      result.startValue = Math.min(
        result.startValue,
        result.endValue - minimumChartTimeSpan,
      );
    return result;
  };
  const axisAt = (x: number, y: number) => {
    const instance = chart.current;
    if (!instance || y < gridTop || y > instance.getHeight() - gridBottom)
      return -1;
    const right = instance.getWidth() - layout.right;
    return axes.findIndex((axis, index) => {
      const axisX =
        axis.position === "left"
          ? layout.left - layout.offsets[index]
          : right + layout.offsets[index];
      return axis.position === "left"
        ? x >= axisX - layout.widths[index] && x <= axisX + 3
        : x >= axisX - 3 && x <= axisX + layout.widths[index];
    });
  };
  const updateCursor = (point: { x: number; y: number }, ctrl: boolean) => {
    const gesture = mouseGesture.current;
    const cursor =
      gesture?.kind === "brush"
        ? "crosshair"
        : gesture?.kind === "axis"
          ? "ns-resize"
          : gesture?.kind === "pan"
            ? "grabbing"
            : !hasCurve
              ? "not-allowed"
              : ctrl && axisAt(point.x, point.y) >= 0
                ? axisHasCurve(axes[axisAt(point.x, point.y)])
                  ? "ns-resize"
                  : "not-allowed"
                : ctrl &&
                    chart.current?.containPixel({ gridIndex: 0 }, [
                      point.x,
                      point.y,
                    ])
                  ? "crosshair"
                  : "";
    if (ref.current) {
      ref.current.dataset.cursor = cursor;
      ref.current.style.setProperty("--chart-cursor", cursor || "auto");
    }
  };
  modifier.current = (event) => {
    if (mousePosition.current)
      updateCursor(mousePosition.current, event.ctrlKey);
  };
  const beginDrag = (
    point: { x: number; y: number },
    id: number,
    modified: boolean,
  ) => {
    const instance = chart.current;
    const element = ref.current;
    if (!instance || !element || !hasCurve) return false;
    const axisIndex = modified ? axisAt(point.x, point.y) : -1;
    if (axisIndex >= 0) {
      const axis = axes[axisIndex];
      if (!axisHasCurve(axis)) return false;
      manualGridCount.current = axes[0].gridCount;
      mouseGesture.current = {
        kind: "axis",
        id,
        y: point.y,
        cellHeight:
          (instance.getHeight() - gridBottom - gridTop) / axis.gridCount,
        axis,
      };
      hidePointer();
    } else {
      if (
        samples.length < 2 ||
        !instance.containPixel({ gridIndex: 0 }, [point.x, point.y])
      )
        return false;
      mouseGesture.current = {
        kind: modified ? "brush" : "pan",
        id,
        x: point.x,
        left: layout.left,
        width: instance.getWidth() - layout.left - layout.right,
        range: { ...(zoom.current ?? timeDomain()) },
        domain: timeDomain(),
      };
      if (modified && selection.current) {
        Object.assign(selection.current.style, {
          display: "block",
          left: `${point.x}px`,
          top: `${gridTop}px`,
          width: "0px",
          height: `${instance.getHeight() - gridBottom - gridTop}px`,
        });
        hidePointer();
      }
    }
    element.setPointerCapture(id);
    lockCursor(
      mouseGesture.current.kind === "brush"
        ? "crosshair"
        : mouseGesture.current.kind === "axis"
          ? "ns-resize"
          : "grabbing",
    );
    updateCursor(point, modified);
    return true;
  };
  activateTouch.current = (id) => {
    const pending = singleTouch.current;
    if (
      !pending ||
      pending.id !== id ||
      pending.mode !== "pending" ||
      touchPointers.current.size !== 1
    )
      return;
    pending.timer = undefined;
    pending.mode = "drag";
    beginDrag(pending.point, id, true);
  };
  mouse.current = (event) => {
    const touching = event.pointerType === "touch";
    if (
      !touching &&
      event.pointerType !== "mouse" &&
      event.pointerType !== "pen"
    )
      return;
    const instance = chart.current;
    const element = ref.current;
    if (!instance || !element) return;
    const point = chartPoint(event.clientX, event.clientY);
    if (!point) return;
    if (touching) {
      const contacts = touchPointers.current;
      if (event.type === "pointerdown") {
        if (!event.isPrimary && !contacts.size) return;
        const inPlot = instance.containPixel({ gridIndex: 0 }, [
          point.x,
          point.y,
        ]);
        if (!contacts.size && !inPlot && axisAt(point.x, point.y) < 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        contacts.add(event.pointerId);
        clearSingleTouch();
        if (contacts.size > 1) {
          const gesture = mouseGesture.current;
          mouseGesture.current = null;
          lockCursor();
          if (selection.current) selection.current.style.display = "none";
          if (gesture && element.hasPointerCapture(gesture.id))
            element.releasePointerCapture(gesture.id);
          return;
        }
        singleTouch.current = {
          id: event.pointerId,
          point,
          clientX: event.clientX,
          clientY: event.clientY,
          lastY: event.clientY,
          inPlot,
          mode: "pending",
          timer: setTimeout(() => activateTouch.current(event.pointerId), 450),
        };
        element.setPointerCapture(event.pointerId);
        return;
      }
      if (!contacts.has(event.pointerId)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerup" || event.type === "pointercancel") {
        contacts.delete(event.pointerId);
        const pending = singleTouch.current;
        clearSingleTouch();
        if (!mouseGesture.current) {
          if (element.hasPointerCapture(event.pointerId))
            element.releasePointerCapture(event.pointerId);
          if (event.type === "pointerup" && pending?.mode === "pending") {
            pointer.current = point;
            showPointer();
          }
          return;
        }
      } else {
        if (contacts.size !== 1 || pinch.current) return;
        const pending = singleTouch.current;
        if (!pending || pending.id !== event.pointerId) return;
        if (pending.mode === "pending") {
          const dx = event.clientX - pending.clientX;
          const dy = event.clientY - pending.clientY;
          if (Math.hypot(dx, dy) < 8) return;
          clearTimeout(pending.timer);
          pending.timer = undefined;
          if (
            pending.inPlot &&
            Math.abs(point.x - pending.point.x) >
              Math.abs(point.y - pending.point.y)
          ) {
            pending.mode = "drag";
            beginDrag(pending.point, pending.id, false);
          } else pending.mode = "scroll";
        }
        if (pending.mode === "scroll") {
          const scroller = fullscreen ? null : element.closest(".main-shell");
          if (scroller) {
            const scale =
              scroller.getBoundingClientRect().height / scroller.clientHeight;
            scroller.scrollTop -=
              (event.clientY - pending.lastY) / (scale || 1);
          }
          pending.lastY = event.clientY;
          return;
        }
      }
    } else {
      mousePosition.current = point;
      updateCursor(point, event.ctrlKey);
      if (event.type === "pointerdown") {
        if (!hasCurve || event.button !== 0) return;
        if (!beginDrag(point, event.pointerId, event.ctrlKey)) return;
      }
    }
    const gesture = mouseGesture.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const x =
      gesture.kind === "brush"
        ? Math.max(
            gesture.left,
            Math.min(gesture.left + gesture.width, point.x),
          )
        : point.x;
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (
        gesture.kind === "brush" &&
        event.type === "pointerup" &&
        Math.abs(x - gesture.x) >= 4
      ) {
        const span = gesture.range.endValue - gesture.range.startValue;
        instance.dispatchAction({
          type: "dataZoom",
          ...clampChartTimeRange(
            {
              startValue:
                gesture.range.startValue +
                ((Math.min(x, gesture.x) - gesture.left) / gesture.width) *
                  span,
              endValue:
                gesture.range.startValue +
                ((Math.max(x, gesture.x) - gesture.left) / gesture.width) *
                  span,
            },
            gesture.domain,
          ),
        });
      }
      mouseGesture.current = null;
      lockCursor();
      if (selection.current) selection.current.style.display = "none";
      if (element.hasPointerCapture(event.pointerId))
        element.releasePointerCapture(event.pointerId);
      updateCursor(point, event.ctrlKey);
      return;
    }
    if (event.type === "pointermove") {
      if (gesture.kind === "brush") {
        if (selection.current) {
          selection.current.style.left = `${Math.min(x, gesture.x)}px`;
          selection.current.style.width = `${Math.abs(x - gesture.x)}px`;
        }
        return;
      }
      if (gesture.kind === "axis") {
        const steps = Math.round((point.y - gesture.y) / gesture.cellHeight);
        if (steps) {
          const requested = panChartAxis(gesture.axis, steps);
          const range = constrainValueRange(gesture.axis, requested, true);
          if (range) {
            gesture.y =
              Math.abs(range.startValue - requested.startValue) > 1e-8
                ? point.y
                : gesture.y + steps * gesture.cellHeight;
            gesture.axis = resolveChartTicks(
              {
                ...gesture.axis,
                min: range.startValue,
                max: range.endValue,
                customMin: true,
                customMax: true,
              },
              gesture.axis.gridCount,
              gesture.axis.magnitude,
              true,
            );
            setYRanges((ranges) => ({
              ...ranges,
              [gesture.axis.unit]: { ...range, panned: true },
            }));
          }
        }
        return;
      }
      const span = gesture.range.endValue - gesture.range.startValue;
      const delta = ((point.x - gesture.x) / Math.max(1, gesture.width)) * span;
      const startValue = Math.max(
        gesture.domain.startValue,
        Math.min(
          gesture.domain.endValue - span,
          gesture.range.startValue - delta,
        ),
      );
      pointer.current = point;
      instance.dispatchAction({
        type: "dataZoom",
        startValue,
        endValue: startValue + span,
      });
      showPointer();
    }
  };
  wheel.current = (event) => {
    const instance = chart.current;
    if (!instance || !ref.current || !event.deltaY || !event.ctrlKey) return;
    if (!hasCurve) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const { x, y } = chartPoint(event.clientX, event.clientY)!;
    const right = instance.getWidth() - layout.right;
    const bottom = instance.getHeight() - gridBottom;
    let axisIndex = axisAt(x, y);
    const previousAxis = wheelAxis.current;
    const now = performance.now();
    if (
      previousAxis &&
      now - previousAxis.at < 300 &&
      Math.abs(event.clientX - previousAxis.x) < 2 &&
      Math.abs(event.clientY - previousAxis.y) < 2
    ) {
      const latched = axes.findIndex((axis) => axis.unit === previousAxis.unit);
      if (latched >= 0) axisIndex = latched;
    }
    const onTimeAxis =
      x >= layout.left &&
      x <= right &&
      y > bottom &&
      y < instance.getHeight() - (fullscreen ? 0 : 24);
    const inPlot =
      x >= layout.left && x <= right && y >= gridTop && y <= bottom;
    if (axisIndex < 0 && !onTimeAxis && !inPlot) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (axisIndex >= 0) {
      const axis = axes[axisIndex];
      if (!axisHasCurve(axis)) return;
      // Tick widths may change within one wheel gesture; keep targeting the
      // original unit until the pointer moves or the gesture becomes idle.
      wheelAxis.current = {
        unit: axis.unit,
        x: event.clientX,
        y: event.clientY,
        at: now,
      };
      manualGridCount.current = axes[0].gridCount;
      setYRanges((ranges) => {
        const current = ranges[axis.unit]
          ? resolveChartTicks(
              {
                ...axis,
                min: ranges[axis.unit].startValue,
                max: ranges[axis.unit].endValue,
                customMin: true,
                customMax: true,
              },
              axis.gridCount,
              axis.magnitude,
              ranges[axis.unit]?.panned,
            )
          : axis;
        const range = constrainValueRange(
          current,
          zoomChartAxis(
            current,
            1 - (y - gridTop) / (bottom - gridTop),
            event.deltaY,
          ),
        );
        if (!range) return ranges;
        if (range.startValue === current.min && range.endValue === current.max)
          return ranges;
        return {
          ...ranges,
          [axis.unit]: range,
        };
      });
    } else if (samples.length > 1) {
      wheelAxis.current = null;
      const currentDomain = timeDomain();
      const next = zoomAxisRange(
        zoom.current ?? currentDomain,
        (x - layout.left) / (right - layout.left),
        event.deltaY,
        minimumChartTimeSpan,
        currentDomain,
      );
      instance.dispatchAction({ type: "dataZoom", ...next });
    }
  };
  touch.current = (event) => {
    const instance = chart.current;
    const element = ref.current;
    if (!instance || !element) return;
    if (!hasCurve) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.touches.length !== 2) {
      pinch.current = null;
      if (touchPointers.current.size) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (!touchPointers.current.size) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearSingleTouch();
    const [a, b] = Array.from(event.touches);
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const ids = [a.identifier, b.identifier].sort((a, b) => a - b);
    if (
      !pinch.current ||
      pinch.current.ids.some((id, index) => id !== ids[index])
    ) {
      const clientX = (a.clientX + b.clientX) / 2;
      const clientY = (a.clientY + b.clientY) / 2;
      const { x, y } = chartPoint(clientX, clientY)!;
      if (distance < 24) return;
      const gesture = mouseGesture.current;
      mouseGesture.current = null;
      lockCursor();
      if (selection.current) selection.current.style.display = "none";
      if (gesture && element.hasPointerCapture(gesture.id))
        element.releasePointerCapture(gesture.id);
      const axisIndex = axisAt(x, y);
      if (axisIndex >= 0) {
        const axis = axes[axisIndex];
        if (!axisHasCurve(axis)) return;
        manualGridCount.current = axes[0].gridCount;
        pinch.current = {
          kind: "axis",
          axis,
          panned: yRanges[axis.unit]?.panned,
          distance,
          anchor:
            1 - (y - gridTop) / (instance.getHeight() - gridBottom - gridTop),
          ids,
        };
      } else {
        if (!instance.containPixel({ gridIndex: 0 }, [x, y])) return;
        const currentDomain = timeDomain();
        pinch.current = {
          kind: "time",
          distance,
          anchor:
            (x - layout.left) /
            (instance.getWidth() - layout.right - layout.left),
          range: { ...(zoom.current ?? currentDomain) },
          domain: currentDomain,
          ids,
        };
      }
      hidePointer();
    }
    if (event.type !== "touchmove") return;
    const initial = pinch.current;
    if (initial.kind === "axis") {
      const range = constrainValueRange(
        initial.axis,
        pinchChartAxis(
          initial.axis,
          initial.anchor,
          initial.distance,
          distance,
        ),
      );
      if (!range) return;
      setYRanges((ranges) => {
        const previous = ranges[initial.axis.unit];
        if (
          (previous?.startValue ?? initial.axis.min) === range.startValue &&
          (previous?.endValue ?? initial.axis.max) === range.endValue
        )
          return ranges;
        return {
          ...ranges,
          [initial.axis.unit]: {
            ...range,
            panned:
              range.startValue === initial.axis.min &&
              range.endValue === initial.axis.max
                ? initial.panned
                : undefined,
          },
        };
      });
      return;
    }
    instance.dispatchAction({
      type: "dataZoom",
      ...pinchAxisRange(
        initial.range,
        initial.anchor,
        initial.distance,
        distance,
        initial.domain,
      ),
    });
  };
  useEffect(() => {
    if (!ref.current) return;
    const uiScale =
      Number(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--ui-scale",
        ),
      ) || 1;
    chart.current = init(ref.current, undefined, {
      renderer: "canvas",
      devicePixelRatio: window.devicePixelRatio * uiScale,
    });
    chart.current.on("datazoom", syncSelectedRange);
    let hoverFrame = 0;
    chart.current.getZr().on("mousemove", (event) => {
      const native = event.event as
        (MouseEvent & Partial<TouchEvent>) | undefined;
      const source =
        native?.touches?.[0] ?? native?.changedTouches?.[0] ?? native;
      const physical =
        Number.isFinite(source?.clientX) && Number.isFinite(source?.clientY);
      // showTip also emits synthetic moves containing only chart coordinates.
      // Reprocessing them as native input loses the raw row and loops each frame.
      pointer.current = (physical
        ? coordinates.current(source!.clientX, source!.clientY)
        : undefined) ?? { x: event.offsetX, y: event.offsetY };
      const position = pointer.current;
      cancelAnimationFrame(hoverFrame);
      if (
        !chart.current?.containPixel({ gridIndex: 0 }, [position.x, position.y])
      )
        hidePointer();
      else if (physical) hoverFrame = requestAnimationFrame(showPointer);
    });
    chart.current.getZr().on("globalout", () => {
      cancelAnimationFrame(hoverFrame);
      pointer.current = undefined;
      hidePointer();
    });
    const onWheel = (event: WheelEvent) => wheel.current(event);
    let pinchFrame = 0;
    let pendingTouch: TouchEvent | undefined;
    const onTouch = (event: TouchEvent) => {
      if (
        event.type === "touchmove" &&
        pinch.current &&
        event.touches.length === 2
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pendingTouch = event;
        if (!pinchFrame)
          pinchFrame = requestAnimationFrame(() => {
            pinchFrame = 0;
            if (pendingTouch) touch.current(pendingTouch);
            pendingTouch = undefined;
          });
      } else {
        if (pendingTouch) touch.current(pendingTouch);
        pendingTouch = undefined;
        cancelAnimationFrame(pinchFrame);
        pinchFrame = 0;
        touch.current(event);
      }
    };
    const element = ref.current;
    let releaseFrame = 0;
    const blockEmptyInput = (event: Event) => {
      if (interactionAllowed.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      element.dataset.cursor = "not-allowed";
      element.style.setProperty("--chart-cursor", "not-allowed");
    };
    const startInteraction = (event: PointerEvent) => {
      if (!interactionAllowed.current) {
        blockEmptyInput(event);
        return;
      }
      if (event.button === 0) {
        cancelAnimationFrame(releaseFrame);
        interacting.current = true;
      }
      mouse.current(event);
    };
    const moveInteraction = (event: PointerEvent) => mouse.current(event);
    const endInteraction = (event?: PointerEvent | Event) => {
      if (event instanceof PointerEvent) mouse.current(event);
      else {
        clearTouchPointers();
        const gesture = mouseGesture.current;
        mouseGesture.current = null;
        lockCursor();
        if (selection.current) selection.current.style.display = "none";
        element.dataset.cursor = interactionAllowed.current
          ? ""
          : "not-allowed";
        if (gesture && element.hasPointerCapture(gesture.id))
          element.releasePointerCapture(gesture.id);
      }
      if (
        event instanceof PointerEvent &&
        event.pointerType === "touch" &&
        touchPointers.current.size
      )
        return;
      if (!interacting.current) return;
      // Let ECharts finish the drag and publish its final range before applying
      // queued samples. Recreating options mid-gesture cancels its drag state.
      cancelAnimationFrame(releaseFrame);
      cancelAnimationFrame(hoverFrame);
      releaseFrame = requestAnimationFrame(() => {
        interacting.current = false;
        if (queuedResize.current) {
          queuedResize.current = false;
          chart.current?.resize();
        }
        if (queuedUpdate.current) setInteractionRevision((value) => value + 1);
        if (lazy.current) {
          viewportUpdate.current();
          clearTimeout(publishTimer.current);
          setSelectedRange(pendingRange.current);
        }
      });
    };
    const onModifier = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mouseGesture.current?.kind === "brush")
        endInteraction(event);
      else if (event.key === "Control") modifier.current(event);
    };
    element.addEventListener("pointerdown", startInteraction, true);
    for (const name of ["mousedown", "click", "dblclick"])
      element.addEventListener(name, blockEmptyInput, true);
    window.addEventListener("pointermove", moveInteraction, true);
    window.addEventListener("pointerup", endInteraction, true);
    window.addEventListener("pointercancel", endInteraction, true);
    window.addEventListener("blur", endInteraction);
    window.addEventListener("keydown", onModifier, true);
    window.addEventListener("keyup", onModifier, true);
    element.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
      element.addEventListener(name, onTouch as EventListener, {
        capture: true,
        passive: false,
      });
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (interacting.current) {
          queuedResize.current = true;
          return;
        }
        const instance = chart.current;
        if (
          instance &&
          (Math.abs(instance.getWidth() - element.clientWidth) >= 1 ||
            Math.abs(instance.getHeight() - element.clientHeight) >= 1)
        ) {
          instance.resize();
          viewportUpdate.current();
          showPointer();
        }
      });
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(hoverFrame);
      cancelAnimationFrame(releaseFrame);
      cancelAnimationFrame(pinchFrame);
      clearTouchPointers();
      cancelAnimationFrame(viewportFrame.current);
      clearTimeout(publishTimer.current);
      element.removeEventListener("pointerdown", startInteraction, true);
      for (const name of ["mousedown", "click", "dblclick"])
        element.removeEventListener(name, blockEmptyInput, true);
      window.removeEventListener("pointermove", moveInteraction, true);
      window.removeEventListener("pointerup", endInteraction, true);
      window.removeEventListener("pointercancel", endInteraction, true);
      window.removeEventListener("blur", endInteraction);
      window.removeEventListener("keydown", onModifier, true);
      window.removeEventListener("keyup", onModifier, true);
      element.removeEventListener("wheel", onWheel, { capture: true });
      for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
        element.removeEventListener(name, onTouch as EventListener, {
          capture: true,
        });
      chart.current?.dispose();
      lockCursor();
      mouseGesture.current = null;
      chart.current = null;
    };
  }, [
    syncSelectedRange,
    showPointer,
    hidePointer,
    lockCursor,
    clearTouchPointers,
  ]);
  useEffect(() => {
    if (hasCurve) {
      if (ref.current?.dataset.cursor === "not-allowed")
        ref.current.dataset.cursor = "";
      return;
    }
    const gesture = mouseGesture.current;
    mouseGesture.current = null;
    clearTouchPointers();
    interacting.current = false;
    pinch.current = null;
    wheelAxis.current = null;
    if (selection.current) selection.current.style.display = "none";
    if (gesture && ref.current?.hasPointerCapture(gesture.id))
      ref.current.releasePointerCapture(gesture.id);
    lockCursor();
    if (ref.current) {
      ref.current.dataset.cursor = "not-allowed";
      ref.current.style.setProperty("--chart-cursor", "not-allowed");
    }
  }, [hasCurve, lockCursor, clearTouchPointers]);
  useEffect(() => {
    if (
      interacting.current &&
      mouseGesture.current?.kind !== "axis" &&
      pinch.current?.kind !== "axis"
    ) {
      queuedUpdate.current = true;
      return;
    }
    queuedUpdate.current = false;
    const color = theme.colorNeutralForeground3;
    // Let ECharts infer range mode from the supplied values. A fixed rangeMode
    // would override later percent-based slider actions on series-only updates.
    const zoomRange = zoom.current
      ? {
          startValue: zoom.current.startValue,
          ...(zoom.current.followEnd
            ? { end: 100 }
            : { endValue: zoom.current.endValue }),
        }
      : { start: 0, end: 100 };
    const displayed = viewportData();
    chart.current?.setOption(
      {
        backgroundColor: "transparent",
        animation: false,
        textStyle: {
          fontFamily: theme.fontFamilyBase,
          fontSize: Number.parseFloat(theme.fontSizeBase200),
          color: theme.colorNeutralForeground1,
        },
        grid: {
          left: layout.left,
          right: layout.right,
          top: gridTop,
          bottom: gridBottom,
        },
        tooltip: {
          show: hasCurve,
          className: "curve-tooltip",
          trigger: "axis",
          triggerOn: "none",
          confine: true,
          transitionDuration: 0,
          hideDelay: 0,
          formatter: rawTooltip,
          backgroundColor: theme.colorNeutralBackground1,
          borderColor: theme.colorNeutralStroke1,
          borderRadius: Number.parseFloat(theme.borderRadiusMedium),
          textStyle: { color: theme.colorNeutralForeground1 },
          extraCssText: `box-shadow: ${theme.shadow16};`,
        },
        axisPointer: {
          // Hover is shown only after checking the original recording segment.
          triggerOn: "none",
          triggerEmphasis: false,
          show: hasCurve ? "auto" : false,
          lineStyle: { color: theme.colorNeutralStrokeAccessible },
          label: {
            color: theme.colorNeutralForegroundOnBrand,
            backgroundColor: theme.colorBrandBackground,
          },
        },
        xAxis: {
          type: elapsedMode ? "value" : "time",
          boundaryGap: false,
          min: hasSamples ? timeDomain().startValue : undefined,
          max: hasSamples ? timeDomain().endValue : undefined,
          axisPointer: {
            show: hasCurve ? "auto" : false,
            snap: coordinate ? false : undefined,
            label: {
              formatter: ({ value }: { value: number }) =>
                elapsedMode
                  ? formatElapsedTime(value, true)
                  : formatClockTime(value, true),
            },
          },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            show: hasSamples,
            color,
            hideOverlap: true,
            formatter: (v: number) =>
              elapsedMode
                ? v < 0
                  ? ""
                  : formatElapsedTime(v)
                : formatClockTime(v),
          },
          splitLine: {
            show: hasSamples,
            lineStyle: { color: theme.colorNeutralStroke2, type: "dashed" },
          },
        },
        yAxis: axes.map((axis, index) => ({
          id: axis.unit,
          type: "value",
          name: "",
          min: axis.min,
          max: axis.max,
          scale: true,
          splitNumber: axis.gridCount,
          interval: axis.interval,
          position: axis.position,
          offset: layout.offsets[index],
          show: true,
          axisLine: {
            show: true,
            onZero: false,
            lineStyle: { color: theme.colorNeutralStroke2 },
          },
          axisTick: { show: false },
          axisLabel: {
            margin: 8,
            color:
              axis.unit === "°C"
                ? color
                : (bounds?.[axis.keys[0]]?.color ??
                  measurementColor(theme, axis.keys[0])),
            hideOverlap: true,
            fontFamily: theme.fontFamilyMonospace,
            align: axis.position === "left" ? "right" : "left",
            formatter: (value: number) =>
              formatAxisValue(
                value,
                axis.unit,
                axis.precision,
                axis.numberWidth,
              ),
          },
          splitLine: {
            show: index === 0,
            lineStyle: {
              color: theme.colorNeutralStroke2,
              type: "dashed",
            },
          },
        })),
        dataZoom: [
          {
            type: "inside",
            disabled: !hasCurve,
            minValueSpan: minimumChartTimeSpan,
            xAxisIndex: 0,
            filterMode: "none",
            // Application handlers own wheel/pinch zoom; ECharts retains dragging.
            zoomLock: true,
            zoomOnMouseWheel: false,
            moveOnMouseWheel: false,
            throttle: coordinate ? 32 : undefined,
            ...zoomRange,
          },
          {
            type: "slider",
            show: !fullscreen,
            showDataShadow: coordinate ? false : "auto",
            throttle: coordinate ? 32 : undefined,
            xAxisIndex: 0,
            filterMode: "none",
            height: 14,
            bottom: 2,
            brushSelect: false,
            minValueSpan: minimumChartTimeSpan,
            zoomLock: !hasCurve,
            borderColor: theme.colorNeutralStroke2,
            backgroundColor: theme.colorNeutralBackground3,
            fillerColor: theme.colorBrandBackground2,
            dataBackground: {
              lineStyle: { color: theme.colorNeutralForeground4 },
              areaStyle: { color: theme.colorNeutralStroke2 },
            },
            selectedDataBackground: {
              lineStyle: { color: theme.colorBrandForeground1 },
              areaStyle: { color: theme.colorBrandBackground2 },
            },
            handleStyle: {
              color: theme.colorBrandForeground1,
              borderColor: theme.colorNeutralBackground1,
            },
            moveHandleStyle: { color: theme.colorBrandForeground1 },
            emphasis: {
              handleStyle: { color: theme.colorCompoundBrandForeground1Hover },
              moveHandleStyle: {
                color: theme.colorCompoundBrandForeground1Hover,
              },
            },
            textStyle: { color },
            showDetail: false,
            ...zoomRange,
          },
        ],
        series: selected.map((key) => ({
          id: key,
          name: `${seriesInfo[key].name} (${seriesInfo[key].unit})`,
          type: "line",
          yAxisIndex: axes.findIndex(
            (axis) => axis.unit === seriesInfo[key].unit,
          ),
          showSymbol: false,
          // Pixel extrema are display-only; tooltips query the original row.
          connectNulls: false,
          lineStyle: {
            width: bounds?.[key]?.width ?? defaultCurveWidth,
            opacity: bounds?.[key]?.lineOpacity ?? 1,
            color: bounds?.[key]?.color ?? measurementColor(theme, key),
          },
          itemStyle: {
            color: bounds?.[key]?.color ?? measurementColor(theme, key),
          },
          areaStyle:
            (bounds?.[key]?.areaOpacity ?? 0) > 0
              ? {
                  color: bounds?.[key]?.color ?? measurementColor(theme, key),
                  opacity: bounds![key]!.areaOpacity,
                }
              : undefined,
          ...(coordinate
            ? {
                dimensions: ["time", "value", "sourceIndex"],
                encode: { x: 0, y: 1, tooltip: [1] },
                data: displayed![key] ?? [],
              }
            : { data: seriesData![key] }),
        })),
      },
      { notMerge: true },
    );
    markers.current?.replaceChildren();
    if (!hasSamples) hidePointer();
    syncSelectedRange();
    showPointer();
  }, [
    samples,
    hasSamples,
    hasCurve,
    selected,
    theme,
    bounds,
    axes,
    layout,
    gridCount,
    syncSelectedRange,
    elapsedMode,
    elapsed?.current,
    elapsed?.fromZero,
    coordinate,
    domain,
    seriesData,
    showPointer,
    hidePointer,
    interactionRevision,
    fullscreen,
    gridTop,
    gridBottom,
  ]);
  return (
    <div className={`chart-wrap${resizing ? " resizing" : ""}`}>
      {!fullscreen && (
        <MeasurementSelector
          selected={selected}
          onChange={onSelectionChange}
          bounds={bounds}
          theme={theme}
        />
      )}
      <dialog
        open
        ref={viewport}
        className={`chart-scroll${fullscreen ? " chart-fullscreen" : ""}${rotate ? " chart-fullscreen-rotated" : ""}`}
        role={fullscreen ? "dialog" : "region"}
        aria-modal={fullscreen || undefined}
        aria-label={fullscreen ? "全屏曲线" : "曲线图表"}
        tabIndex={0}
        onCancel={(event) => {
          event.preventDefault();
          exit();
        }}
      >
        {fullscreen && (
          <div ref={toolbar} className="chart-fullscreen-toolbar">
            <MeasurementSelector
              selected={selected}
              onChange={onSelectionChange}
              bounds={bounds}
              theme={theme}
            />
            <Button
              className="chart-fullscreen-exit"
              icon={<FullScreenMinimize20Regular />}
              onClick={exit}
            >
              退出
            </Button>
          </div>
        )}
        <div
          ref={ref}
          className="trend-chart"
          data-render-mode={coordinate ? "viewport" : "full"}
          data-source-count={samples.length}
          style={{
            minWidth: fullscreen ? 0 : layout.minWidth,
            height: fullscreen ? "100%" : height,
          }}
          aria-label="实时采样曲线"
        />
        <div ref={markers} className="chart-hover-markers" aria-hidden="true" />
        <div
          ref={selection}
          className="chart-range-selection"
          aria-hidden="true"
        />
      </dialog>
      <ChartActions>
        {typeof footerActions === "function"
          ? footerActions(visibleSamples)
          : footerActions}
        <div className="chart-export-actions">
          {exportAction?.(visibleSamples, () =>
            samplesInChartRange(samples, zoom.current, elapsedMode, origin),
          )}
          {onImage && (
            <ChartAction
              label="截图"
              icon={<Camera20Regular />}
              disabled={imageBusy || samples.length === 0}
              onClick={() => {
                if (coordinate) viewportUpdate.current();
                const url = chart.current?.getDataURL({
                  type: "png",
                  pixelRatio: 2,
                  backgroundColor: theme.colorNeutralBackground1,
                  excludeComponents: ["dataZoom"],
                });
                if (url) {
                  const image = new Image();
                  image.onload = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height - 18 * 2;
                    canvas.getContext("2d")!.drawImage(image, 0, 0);
                    onImage(canvas.toDataURL("image/png"));
                  };
                  image.src = url;
                }
              }}
            />
          )}
        </div>
        <div className="chart-view-actions">
          <ChartAction
            label="复原"
            className="chart-reset-zoom"
            icon={<ArrowReset20Regular />}
            disabled={!selectedRange && !Object.keys(yRanges).length}
            onClick={() => {
              clearTimeout(publishTimer.current);
              setYRanges({});
              chart.current?.dispatchAction({
                type: "dataZoom",
                start: 0,
                end: 100,
              });
              setSelectedRange(undefined);
            }}
          />
          <ChartAction
            label="全屏"
            icon={<FullScreenMaximize20Regular />}
            onClick={enter}
          />
        </div>
      </ChartActions>
      <div
        className={`chart-resize-handle${resizing ? " resizing" : ""}`}
        role="separator"
        aria-label="调整曲线高度"
        aria-orientation="horizontal"
        aria-valuemin={chartHeightLimits.min}
        aria-valuemax={chartHeightLimits.max}
        aria-valuenow={height}
        aria-valuetext={`${height} 像素，纵轴 ${gridCount} 格`}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          resizeLayout.begin(event.currentTarget);
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          const scale =
            Number(
              getComputedStyle(document.documentElement).getPropertyValue(
                "--ui-scale",
              ),
            ) || 1;
          drag.current = {
            id: event.pointerId,
            y: event.clientY,
            height,
            scale,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId) {
            pendingHeight.current =
              start.height + (event.clientY - start.y) / start.scale;
            if (!heightFrame.current)
              heightFrame.current = requestAnimationFrame(flushChartHeight);
          }
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) {
            finishResize();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onLostPointerCapture={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 100 : 20;
          const value =
            event.key === "ArrowUp"
              ? height - step
              : event.key === "ArrowDown"
                ? height + step
                : event.key === "Home"
                  ? chartHeightLimits.min
                  : event.key === "End"
                    ? chartHeightLimits.max
                    : null;
          if (value !== null) {
            event.preventDefault();
            setChartHeight(value);
          }
        }}
      />
    </div>
  );
}
