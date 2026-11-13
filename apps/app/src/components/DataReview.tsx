import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type Theme,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import type { Telemetry } from "../lib/types";
import {
  filterSamples,
  measurements,
  measurementKeys,
  summarize,
  type ChartBounds,
  type MeasurementKey,
} from "../lib/analysis";
import { TrendChart, type ChartTimeRange } from "./TrendChart";
import { MeasurementSelector } from "./MeasurementSelector";
import { ChartTimeSelect } from "./ChartTimeSelect";
import { sampleElapsedMs, type ChartTimeMode } from "../lib/chartTime";
import { samplesInChartRange } from "../lib/chartInteraction";
import { completeRecordCounters } from "../lib/records";

const format = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: 3,
        useGrouping: false,
      });

export function DataReview({
  rows: sourceRows,
  title,
  theme,
  bounds,
  busy,
  onImage,
  onExport,
  timeMode,
  onTimeModeChange,
  selected,
  onSelectionChange,
}: {
  rows: Telemetry[];
  title: string;
  theme: Theme;
  bounds: ChartBounds;
  busy: boolean;
  onImage: (url: string) => void;
  onExport: (rows: Telemetry[]) => void;
  timeMode: ChartTimeMode;
  onTimeModeChange: (mode: ChartTimeMode) => void;
  selected: MeasurementKey[];
  onSelectionChange: (selected: MeasurementKey[]) => void;
}) {
  const rows = useMemo(() => completeRecordCounters(sourceRows), [sourceRows]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [chartRange, setChartRange] = useState<ChartTimeRange>();
  const available = useMemo(
    () =>
      (Object.keys(measurements) as MeasurementKey[]).filter((key) =>
        rows.length === 0
          ? ["voltage", "current", "power"].includes(key)
          : rows.some((row) => row[key] != null),
      ),
    [rows],
  );
  const keys = selected;
  const start = from ? new Date(from).getTime() : undefined;
  const end = to ? new Date(to).getTime() : undefined;
  const invalidRange =
    (start !== undefined && !Number.isFinite(start)) ||
    (end !== undefined && !Number.isFinite(end)) ||
    (start !== undefined && end !== undefined && start > end);
  const filtered = useMemo(
    () => filterSamples(rows, start, end),
    [rows, start, end],
  );
  const origin = rows[0]?.timestamp ?? 0;
  const exportRows = useMemo(
    () =>
      samplesInChartRange(filtered, chartRange, timeMode === "elapsed", origin),
    [filtered, chartRange, timeMode, origin],
  );
  const stats = useMemo(
    () =>
      Object.fromEntries(keys.map((key) => [key, summarize(exportRows, key)])),
    [exportRows, keys],
  );
  const pages = Math.max(1, Math.ceil(exportRows.length / 100));
  const currentPage = Math.min(page, pages - 1);
  const detailRows = exportRows
    .slice(
      Math.max(0, exportRows.length - (currentPage + 1) * 100),
      exportRows.length - currentPage * 100,
    )
    .reverse();
  const rangeLabel = exportRows.length
    ? `${new Date(exportRows[0].timestamp).toLocaleString()} — ${new Date(exportRows.at(-1)!.timestamp).toLocaleString()}`
    : "暂无可显示的数据";

  return (
    <>
      <Card className="review-card">
        <div className="section-head review-heading">
          <div>
            <h2>{title}</h2>
            <span>
              {exportRows.length.toLocaleString()} /{" "}
              {rows.length.toLocaleString()} 个采样点 · {rangeLabel}
            </span>
          </div>
          <div className="chart-toolbar">
            <ChartTimeSelect
              value={timeMode}
              onChange={(mode) => {
                setChartRange(undefined);
                onTimeModeChange(mode);
              }}
            />
          </div>
        </div>
        <div className="review-time-range">
          <Field label="开始时间">
            <Input
              aria-label="回看开始时间"
              type="datetime-local"
              step="1"
              value={from}
              onChange={(_, d) => {
                setFrom(d.value);
                setPage(0);
              }}
            />
          </Field>
          <Field label="结束时间">
            <Input
              aria-label="回看结束时间"
              type="datetime-local"
              step="1"
              value={to}
              onChange={(_, d) => {
                setTo(d.value);
                setPage(0);
              }}
            />
          </Field>
          <Button
            disabled={!from && !to}
            onClick={() => {
              setFrom("");
              setTo("");
              setPage(0);
            }}
          >
            全部时间
          </Button>
        </div>
        {invalidRange && (
          <MessageBar intent="error">
            <MessageBarBody>
              时间范围无效，开始时间必须早于或等于结束时间。
            </MessageBarBody>
          </MessageBar>
        )}
        <MeasurementSelector
          selected={keys}
          onChange={onSelectionChange}
          bounds={bounds}
          theme={theme}
        />
        <TrendChart
          key={`${from}|${to}|${timeMode}`}
          samples={filtered}
          elapsed={
            timeMode === "elapsed"
              ? {
                  origin,
                  current: filtered.length
                    ? sampleElapsedMs(filtered.at(-1)!, origin)
                    : 0,
                  fromZero: !from && !to,
                }
              : undefined
          }
          selected={keys}
          bounds={bounds}
          theme={theme}
          onImage={onImage}
          imageBusy={busy}
          onRangeChange={setChartRange}
          exportAction={() => (
            <Button
              icon={<ArrowDownload20Regular />}
              disabled={busy || !exportRows.length || invalidRange}
              onClick={() => onExport(exportRows)}
            >
              导出 CSV
            </Button>
          )}
        />
      </Card>
      <Card className="table-card">
        <div className="section-head">
          <div>
            <h2>采样统计</h2>
            <span>
              电量、容量不计算均值；标注“计算”的累计值由功率、电流按采样间隔积分得到。
            </span>
          </div>
        </div>
        <div className="table-scroll">
          <Table className="sample-table" aria-label="采样统计">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>通道</TableHeaderCell>
                <TableHeaderCell>有效点数</TableHeaderCell>
                <TableHeaderCell>最小值</TableHeaderCell>
                <TableHeaderCell>最大值</TableHeaderCell>
                <TableHeaderCell>平均值</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {measurementKeys
                .filter((key) => keys.includes(key))
                .map((key) => (
                  <TableRow key={key}>
                    <TableCell>
                      {measurements[key].name} / {measurements[key].unit}
                      {((key === "energy" &&
                        exportRows.some((row) => row.energyCalculated)) ||
                        (key === "capacity" &&
                          exportRows.some((row) => row.capacityCalculated))) &&
                        " · 计算"}
                    </TableCell>
                    <TableCell>{stats[key]?.count ?? 0}</TableCell>
                    <TableCell>{format(stats[key]?.min)}</TableCell>
                    <TableCell>{format(stats[key]?.max)}</TableCell>
                    <TableCell>{format(stats[key]?.average)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      <Card className="table-card">
        <div className="section-head">
          <h2>采样明细</h2>
          <span>
            {exportRows.length.toLocaleString()} 条 · 每页 100 条 · 最新在前
          </span>
        </div>
        <div className="table-scroll">
          <Table className="sample-table" aria-label="采样明细">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>时间</TableHeaderCell>
                {available.map((key) => (
                  <TableHeaderCell key={key}>
                    {measurements[key].name} / {measurements[key].unit}
                  </TableHeaderCell>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detailRows.map((row, index) => (
                <TableRow key={`${row.timestamp}-${index}`}>
                  <TableCell>
                    {new Date(row.timestamp).toLocaleString()}
                  </TableCell>
                  {available.map((key) => (
                    <TableCell className="mono" key={key}>
                      {format(row[key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!exportRows.length && (
          <div className="table-empty">
            {rows.length
              ? "该时间范围内没有采样点"
              : "导入 CSV、打开本机记录，或连接设备开始采集"}
          </div>
        )}
        <div className="review-pagination">
          <Button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <span>
            第 {currentPage + 1} / {pages} 页
          </span>
          <Button
            disabled={currentPage === pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </div>
      </Card>
    </>
  );
}
