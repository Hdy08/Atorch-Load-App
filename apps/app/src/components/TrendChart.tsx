import {
  useCallback,
  useEffect,
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
  indexedChartData,
  chartViewportData,
  nearestChartSample,
} from "../lib/chartData";
import { sampleElapsedMs } from "../lib/chartTime";
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
  defaultCurveWidth,
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
  exportAction?: (
    rows: Telemetry[],
    getCurrentRows: () => Telemetry[],
  ) => ReactNode;
  onRangeChange?: (range: ChartTimeRange | undefined) => void;
  elapsed?: { origin: number; current: number; fromZero: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { viewport, fullscreen, rotate, chartHeight, enter, exit } =
    useChartFullscreen();
  const gridTop = fullscreen ? 48 : 16;
  const gridBottom = fullscreen ? 30 : 55;
  const chart = useRef<ECharts | null>(null);
  const zoom = useRef<(ChartTimeRange & { followEnd: boolean }) | undefined>(
    undefined,
  );
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const wheel = useRef<(event: WheelEvent) => void>(() => {});
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
  const [yRanges, setYRanges] = useState<Record<string, ChartTimeRange>>({});
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
  const gridCount = chartGridCount(fullscreen ? chartHeight : height);
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
    if (!coordinate) return "";
    const first = (Array.isArray(input) ? input[0] : input) as
      { axisValue?: number; value?: number[] } | undefined;
    const position = pointer.current;
    let row: Telemetry | undefined;
    if (
      position &&
      chart.current?.containPixel({ gridIndex: 0 }, [position.x, position.y])
    )
      row = nearestChartSample(
        samples,
        coordinate,
        Number(chart.current.convertFromPixel({ xAxisIndex: 0 }, position.x)),
      );
    else if (first?.value && first.value[2] >= 0) row = samples[first.value[2]];
    else if (first?.axisValue !== undefined)
      row = nearestChartSample(samples, coordinate, Number(first.axisValue));
    if (!row) return "";
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
    return (
      `<div>${time}</div>` +
      selected
        .filter((key) => row[key] != null && Number.isFinite(row[key]))
        .map(
          (key) =>
            `<div class="curve-tooltip-row"><span><i style="background:${escape(bounds?.[key]?.color ?? measurementColor(theme, key))}"></i>${seriesInfo[key].name} (${seriesInfo[key].unit})</span><strong>${row[key]!.toLocaleString("en-US", { maximumFractionDigits: 4, useGrouping: false })}</strong></div>`,
        )
        .join("")
    );
  };
  wheel.current = (event) => {
    const instance = chart.current;
    if (!instance || !ref.current || !event.deltaY) return;
    const rect = ref.current.getBoundingClientRect();
    const x = rotate
      ? ((event.clientY - rect.top) * instance.getWidth()) / rect.height
      : ((event.clientX - rect.left) * instance.getWidth()) / rect.width;
    const y = rotate
      ? ((rect.right - event.clientX) * instance.getHeight()) / rect.width
      : ((event.clientY - rect.top) * instance.getHeight()) / rect.height;
    const right = instance.getWidth() - layout.right;
    const bottom = instance.getHeight() - gridBottom;
    const axisIndex =
      y >= gridTop && y <= bottom
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
      y < instance.getHeight() - (fullscreen ? 0 : 24);
    if (axisIndex < 0 && !onTimeAxis) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (axisIndex >= 0) {
      const axis = axes[axisIndex];
      const next = zoomAxisRange(
        { startValue: axis.min, endValue: axis.max },
        1 - (y - gridTop) / (bottom - gridTop),
        event.deltaY,
        gridCount * (axis.max >= 10 ? 1 : 0.1),
      );
      setYRanges((ranges) => ({ ...ranges, [axis.unit]: next }));
    } else if (samples.length > 1) {
      const timeDomain = { ...domain };
      if (elapsedMode) {
        if (elapsed?.fromZero) timeDomain.startValue = 0;
        timeDomain.endValue = Math.max(
          elapsed?.current ?? 0,
          timeDomain.endValue,
        );
      }
      const next = zoomAxisRange(
        zoom.current ?? timeDomain,
        (x - layout.left) / (right - layout.left),
        event.deltaY,
        1,
        timeDomain,
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
      if (lazy.current) showPointer();
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
    element.addEventListener("pointerdown", startInteraction, true);
    window.addEventListener("pointerup", endInteraction, true);
    window.addEventListener("pointercancel", endInteraction, true);
    window.addEventListener("blur", endInteraction);
    element.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    const resize = new ResizeObserver(() => {
      if (interacting.current) {
        queuedResize.current = true;
        return;
      }
      chart.current?.resize();
      viewportUpdate.current();
      showPointer();
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      cancelAnimationFrame(releaseFrame);
      cancelAnimationFrame(viewportFrame.current);
      clearTimeout(publishTimer.current);
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
    if (interacting.current) {
      queuedUpdate.current = true;
      return;
    }
    queuedUpdate.current = false;
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
          show: hasSamples && selected.length > 0,
          className: "curve-tooltip",
          trigger: "axis",
          confine: true,
          transitionDuration: 0,
          hideDelay: 0,
          formatter: coordinate ? rawTooltip : undefined,
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
          min: coordinate
            ? elapsedMode && elapsed?.fromZero
              ? 0
              : domain.startValue
            : elapsedMode
              ? elapsed?.fromZero
                ? 0
                : "dataMin"
              : undefined,
          max: coordinate
            ? Math.max(domain.endValue, elapsed?.current ?? -Infinity)
            : elapsedMode
              ? Math.max(elapsed?.current ?? 0, 1)
              : undefined,
          axisPointer: {
            show: hasSamples && selected.length > 0 ? "auto" : false,
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
          {
            type: "inside",
            xAxisIndex: 0,
            filterMode: "none",
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
    coordinate,
    domain,
    seriesData,
    showPointer,
    interactionRevision,
    fullscreen,
    gridTop,
    gridBottom,
  ]);
  return (
    <div className="chart-wrap">
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
        {fullscreen && (
          <Button
            className="chart-fullscreen-exit"
            icon={<FullScreenMinimize20Regular />}
            onClick={exit}
          >
            退出全屏
          </Button>
        )}
      </dialog>
      <div className="chart-image-actions">
        {typeof footerActions === "function"
          ? footerActions(visibleSamples)
          : footerActions}
        <div className="chart-export-actions">
          {exportAction?.(visibleSamples, () =>
            samplesInChartRange(samples, zoom.current, elapsedMode, origin),
          )}
          {onImage && (
            <Button
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
        <div className="chart-view-actions">
          <Button
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
          >
            重置缩放
          </Button>
          <Button icon={<FullScreenMaximize20Regular />} onClick={enter}>
            全屏
          </Button>
        </div>
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
