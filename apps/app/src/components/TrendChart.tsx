import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, type Theme } from "@fluentui/react-components";
import { ArrowReset20Regular, Camera20Regular } from "@fluentui/react-icons";
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
  chartTimeline,
  samplesInChartRange,
  zoomAxisRange,
  type ChartTimeRange,
} from "../lib/chartInteraction";
import {
  formatAxisValue,
  chartGridCount,
  chartHeightLimits,
  readChartHeight,
  groupChartAxes,
  resolveChartTicks,
  measurements,
  type ChartBounds,
  type MeasurementKey,
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
  theme: Theme;
  bounds?: ChartBounds;
  imageBusy?: boolean;
  onImage?: (url: string) => void;
  footerActions?: ReactNode | ((rows: Telemetry[]) => ReactNode);
  exportAction?: (rows: Telemetry[]) => ReactNode;
  onRangeChange?: (range: ChartTimeRange | undefined) => void;
  elapsed?: { origin: number; current: number; fromZero: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const zoom = useRef<(ChartTimeRange & { followEnd: boolean }) | undefined>(
    undefined,
  );
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
  const interacting = useRef(false);
  const [interactionRevision, setInteractionRevision] = useState(0);
  const [yRanges, setYRanges] = useState<Record<string, ChartTimeRange>>({});
  const [selectedRange, setSelectedRange] = useState<ChartTimeRange>();
  const elapsedMode = elapsed !== undefined;
  const origin = elapsed?.origin ?? 0;
  const timeline = useMemo(
    () => chartTimeline(samples, elapsedMode, origin),
    [samples, elapsedMode, origin],
  );
  const hasSamples = samples.length > 0;
  const canShowPointer = useRef(false);
  canShowPointer.current = hasSamples && selected.length > 0;
  const showPointer = useCallback(() => {
    const instance = chart.current;
    const position = pointer.current;
    if (
      instance &&
      canShowPointer.current &&
      position &&
      instance.containPixel({ gridIndex: 0 }, [position.x, position.y])
    )
      instance.dispatchAction({ type: "showTip", ...position });
  }, []);
  const syncSelectedRange = useCallback(() => {
    const options = chart.current?.getOption() as {
      dataZoom?: ({ start: number; end: number } & ChartTimeRange)[];
    };
    const range = options?.dataZoom?.[0];
    const next =
      range &&
      (range.start > 0 || range.end < 100) &&
      Number.isFinite(range.startValue) &&
      Number.isFinite(range.endValue)
        ? { startValue: range.startValue, endValue: range.endValue }
        : undefined;
    zoom.current = next
      ? { ...next, followEnd: range!.end >= 100 - 1e-6 }
      : undefined;
    setSelectedRange((previous) =>
      previous?.startValue === next?.startValue &&
      previous?.endValue === next?.endValue
        ? previous
        : next,
    );
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
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const setChartHeight = (value: number) =>
    setHeight(
      Math.max(
        chartHeightLimits.min,
        Math.min(chartHeightLimits.max, Math.round(value)),
      ),
    );
  useEffect(() => {
    localStorage.setItem("atorch-chart-height", String(height));
  }, [height]);
  const gridCount = chartGridCount(height);
  const axes = useMemo(
    () =>
      groupChartAxes(selected, samples, bounds).map((axis) =>
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
          gridCount,
        ),
      ),
    [selected, samples, bounds, gridCount, yRanges],
  );
  useEffect(() => setYRanges({}), [bounds]);
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
  wheel.current = (event) => {
    const instance = chart.current;
    if (!instance || !ref.current || !event.deltaY) return;
    const rect = ref.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * instance.getWidth()) / rect.width;
    const y = ((event.clientY - rect.top) * instance.getHeight()) / rect.height;
    const right = instance.getWidth() - layout.right;
    const bottom = instance.getHeight() - 55;
    const axisIndex =
      y >= 16 && y <= bottom
        ? axes.findIndex((axis, index) => {
            const axisX =
              axis.position === "left"
                ? layout.left - layout.offsets[index]
                : right + layout.offsets[index];
            return axis.position === "left"
              ? x >= axisX - layout.widths[index] && x <= axisX + 3
              : x >= axisX - 3 && x <= axisX + layout.widths[index];
          })
        : -1;
    const onTimeAxis =
      x >= layout.left &&
      x <= right &&
      y > bottom &&
      y < instance.getHeight() - 24;
    if (axisIndex < 0 && !onTimeAxis) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (axisIndex >= 0) {
      const axis = axes[axisIndex];
      const next = zoomAxisRange(
        { startValue: axis.min, endValue: axis.max },
        1 - (y - 16) / (bottom - 16),
        event.deltaY,
        gridCount * (axis.max >= 10 ? 1 : 0.1),
      );
      setYRanges((ranges) => ({ ...ranges, [axis.unit]: next }));
    } else if (samples.length > 1) {
      const domain = timeline.reduce(
        (range, point) => ({
          startValue: Math.min(range.startValue, point.time),
          endValue: Math.max(range.endValue, point.time),
        }),
        { startValue: Infinity, endValue: -Infinity },
      );
      if (elapsedMode) {
        if (elapsed?.fromZero) domain.startValue = 0;
        domain.endValue = Math.max(elapsed?.current ?? 0, domain.endValue);
      }
      const next = zoomAxisRange(
        selectedRange ?? domain,
        (x - layout.left) / (right - layout.left),
        event.deltaY,
        1,
        domain,
      );
      instance.dispatchAction({ type: "dataZoom", ...next });
    }
  };
  useEffect(() => {
    if (!ref.current) return;
    chart.current = init(ref.current, undefined, { renderer: "canvas" });
    chart.current.on("datazoom", syncSelectedRange);
    chart.current.getZr().on("mousemove", (event) => {
      pointer.current = { x: event.offsetX, y: event.offsetY };
    });
    chart.current.getZr().on("globalout", () => {
      pointer.current = undefined;
      chart.current?.dispatchAction({ type: "hideTip" });
    });
    const onWheel = (event: WheelEvent) => wheel.current(event);
    const element = ref.current;
    let releaseFrame = 0;
    const startInteraction = (event: PointerEvent) => {
      if (event.button === 0) {
        cancelAnimationFrame(releaseFrame);
        interacting.current = true;
      }
    };
    const endInteraction = () => {
      if (!interacting.current) return;
      // Let ECharts finish the drag and publish its final range before applying
      // queued samples. Recreating options mid-gesture cancels its drag state.
      cancelAnimationFrame(releaseFrame);
      releaseFrame = requestAnimationFrame(() => {
        interacting.current = false;
        chart.current?.resize();
        setInteractionRevision((value) => value + 1);
      });
    };
    element.addEventListener("pointerdown", startInteraction, true);
    window.addEventListener("pointerup", endInteraction, true);
    window.addEventListener("pointercancel", endInteraction, true);
    window.addEventListener("blur", endInteraction);
    element.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    const resize = new ResizeObserver(() => {
      if (interacting.current) return;
      chart.current?.resize();
      showPointer();
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      cancelAnimationFrame(releaseFrame);
      element.removeEventListener("pointerdown", startInteraction, true);
      window.removeEventListener("pointerup", endInteraction, true);
      window.removeEventListener("pointercancel", endInteraction, true);
      window.removeEventListener("blur", endInteraction);
      element.removeEventListener("wheel", onWheel, { capture: true });
      chart.current?.dispose();
      chart.current = null;
    };
  }, [syncSelectedRange, showPointer]);
  useEffect(() => {
    if (interacting.current) return;
    const color = theme.colorNeutralForeground3;
    const zoomRange = zoom.current
      ? {
          rangeMode: ["value", zoom.current.followEnd ? "percent" : "value"],
          startValue: zoom.current.startValue,
          ...(zoom.current.followEnd
            ? { end: 100 }
            : { endValue: zoom.current.endValue }),
        }
      : { start: 0, end: 100 };
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
          top: 16,
          bottom: 55,
        },
        tooltip: {
          show: hasSamples && selected.length > 0,
          className: "curve-tooltip",
          trigger: "axis",
          confine: true,
          transitionDuration: 0,
          hideDelay: 0,
          valueFormatter: (value: unknown) =>
            typeof value === "number"
              ? value.toLocaleString("en-US", {
                  maximumFractionDigits: 4,
                  useGrouping: false,
                })
              : "—",
          backgroundColor: theme.colorNeutralBackground1,
          borderColor: theme.colorNeutralStroke1,
          borderRadius: Number.parseFloat(theme.borderRadiusMedium),
          textStyle: { color: theme.colorNeutralForeground1 },
          extraCssText: `box-shadow: ${theme.shadow16};`,
        },
        axisPointer: {
          show: hasSamples && selected.length > 0 ? "auto" : false,
          lineStyle: { color: theme.colorNeutralStrokeAccessible },
          label: {
            color: theme.colorNeutralForegroundOnBrand,
            backgroundColor: theme.colorBrandBackground,
          },
        },
        xAxis: {
          type: elapsedMode ? "value" : "time",
          min: elapsedMode ? (elapsed?.fromZero ? 0 : "dataMin") : undefined,
          max: elapsedMode ? Math.max(elapsed?.current ?? 0, 1) : undefined,
          axisPointer: {
            show: hasSamples && selected.length > 0 ? "auto" : false,
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
              elapsedMode ? formatElapsedTime(v) : formatClockTime(v),
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
          splitNumber: gridCount,
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
            lineStyle: { color: theme.colorNeutralStroke2, type: "dashed" },
          },
        })),
        dataZoom: [
          { type: "inside", xAxisIndex: 0, filterMode: "none", ...zoomRange },
          {
            type: "slider",
            xAxisIndex: 0,
            filterMode: "none",
            height: 14,
            bottom: 2,
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
          // Every series must retain the same original timestamps. Independent
          // downsampling drops different rows and splits an axis tooltip.
          connectNulls: false,
          lineStyle: {
            width: bounds?.[key]?.width ?? 2,
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
          data: timeline.map(({ time, row }) => [time, row?.[key] ?? null]),
        })),
      },
      { notMerge: true },
    );
    if (!hasSamples) chart.current?.dispatchAction({ type: "hideTip" });
    syncSelectedRange();
    showPointer();
  }, [
    samples,
    hasSamples,
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
    timeline,
    showPointer,
    interactionRevision,
  ]);
  return (
    <div className="chart-wrap">
      <div
        className="chart-scroll"
        role="region"
        aria-label="曲线图表"
        tabIndex={0}
      >
        <div
          ref={ref}
          className="trend-chart"
          style={{ minWidth: layout.minWidth, height }}
          aria-label="实时采样曲线"
        />
      </div>
      <div className="chart-image-actions">
        {typeof footerActions === "function"
          ? footerActions(visibleSamples)
          : footerActions}
        <div className="chart-export-actions">
          {exportAction?.(visibleSamples)}
          {onImage && (
            <Button
              icon={<Camera20Regular />}
              disabled={imageBusy || samples.length === 0}
              onClick={() => {
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
                    canvas.height = image.height - 24 * 2;
                    canvas.getContext("2d")!.drawImage(image, 0, 0);
                    onImage(canvas.toDataURL("image/png"));
                  };
                  image.src = url;
                }
              }}
            >
              截图
            </Button>
          )}
        </div>
        <Button
          className="chart-reset-zoom"
          icon={<ArrowReset20Regular />}
          disabled={!selectedRange && !Object.keys(yRanges).length}
          onClick={() => {
            zoom.current = undefined;
            setYRanges({});
            chart.current?.dispatchAction({
              type: "dataZoom",
              start: 0,
              end: 100,
            });
            setSelectedRange(undefined);
          }}
        >
          重置缩放
        </Button>
      </div>
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
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, y: event.clientY, height };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId)
            setChartHeight(start.height + event.clientY - start.y);
        }}
        onPointerUp={(event) => {
          if (drag.current?.id === event.pointerId) {
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            setResizing(false);
          }
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setResizing(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setResizing(false);
        }}
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
